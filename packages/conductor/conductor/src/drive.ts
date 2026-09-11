/**
 * Conductor state-machine driver.
 *
 * The driver owns the dispatch loop: it asks a {@link ConductorDispatcher} to
 * run the stage's specialist, validates the returned wire record, routes it
 * through {@link routeGate}, records the gate with {@link recordGate}, and
 * repeats until the run reaches the Arbiter's decision or a terminal blocker.
 * The driver never spawns subagents itself — the dispatcher abstracts that seam
 * so the loop is testable against stubbed specialists.
 *
 * @module @deepseek-ai/dsh-conductor/drive
 */

import type {
  ArbiterDecision,
  ConductorRun,
  ConductorStage,
  DecisionRecord,
  DefectClass,
  SpecialistEnvelope,
  SpecialistStatus,
} from './types.ts'
import { gateOfStage, recordGate } from './state.ts'
import { routeGate } from './routing.ts'

/**
 * Spawns specialists and the Arbiter. A dispatcher rejects only on an
 * infrastructure fault; an ordinary specialist failure resolves with a
 * `blocked`/`failed` envelope, which the driver routes to escalation.
 */
export interface ConductorDispatcher {
  /**
   * Run the specialist for `stage` and return its structured envelope.
   * @param stage - the gated stage to dispatch (never `intake`, `ralph`, `closeout`, or `arbiter`).
   * @param run - the current run snapshot.
   */
  dispatchSpecialist(stage: ConductorStage, run: ConductorRun): Promise<SpecialistEnvelope>
  /**
   * Run the Arbiter and return its GO/NO-GO decision.
   * @param run - the current run snapshot with its full gate history.
   */
  dispatchArbiter(run: ConductorRun): Promise<DecisionRecord>
}

/** A terminal driver outcome: the Arbiter's decision, or a blocker. */
export type ConductorOutcome =
  | { readonly kind: 'decision'; readonly decision: DecisionRecord; readonly run: ConductorRun }
  | { readonly kind: 'blocked'; readonly blocker: string; readonly run: ConductorRun }

/**
 * Drive a run from its current stage to the Arbiter's decision or a blocker.
 *
 * Each specialist is dispatched at the stage the run is currently at; a `pass`
 * advances along the linear path, a `rework` routes to the defect-owning stage
 * (bounded by {@link ConductorBudget.maxReworkCycles} inside {@link recordGate}),
 * and a `blocked`/`failed` result parks the run for an owner decision. A
 * malformed envelope or decision is a blocker, never a silent pass.
 * @param run - the initial or resumed run.
 * @param dispatcher - the specialist and Arbiter spawner.
 * @returns the terminal outcome carrying the final run state.
 */
export async function drive(run: ConductorRun, dispatcher: ConductorDispatcher): Promise<ConductorOutcome> {
  let current = run
  while (true) {
    const stage = current.currentStage
    if (stage === 'arbiter') {
      return await settleArbiter(current, dispatcher)
    }
    if (stage === 'intake' || stage === 'ralph' || stage === 'closeout') {
      throw new Error(`Conductor drive cannot dispatch stage "${stage}"`)
    }
    const gate = gateOfStage(stage)
    if (gate === undefined) {
      throw new Error(`Conductor stage "${stage}" owns no gate`)
    }

    const envelope = await dispatcher.dispatchSpecialist(stage, current)
    const malformed = envelopeProblem(envelope, stage, current)
    if (malformed !== undefined) {
      current = recordGate(current, {
        decision: 'escalate',
        basis: [malformed],
        evidenceReviewed: [],
        stateUpdate: `reject malformed ${stage} envelope`,
      })
      return { kind: 'blocked', blocker: malformed, run: current }
    }

    const authorityRequest = authorityChangeRequest(envelope)
    if (authorityRequest !== undefined) {
      current = recordGate(current, {
        decision: 'escalate',
        basis: [authorityRequest.reason],
        evidenceReviewed: envelope.evidence.map(item => item.reference),
        stateUpdate: `authority change requested by ${stage}`,
      })
      return { kind: 'blocked', blocker: `authority change requested: ${authorityRequest.reason}`, run: current }
    }

    const defectClass = envelope.status === 'rework' ? defectClassFromEnvelope(envelope, stage) : undefined
    current = recordGate(current, {
      ...routeGate(gate, envelope.status, defectClass),
      basis: [envelope.summary],
      evidenceReviewed: envelope.evidence.map(item => item.reference),
      stateUpdate: envelope.summary,
    })

    if (current.status === 'running' || current.status === 'rework') continue
    return {
      kind: 'blocked',
      blocker: `run ${current.status} at gate ${gate}`,
      run: current,
    }
  }
}

/** Record the Arbiter's decision and either move to closeout (GO) or escalate (NO-GO). */
async function settleArbiter(current: ConductorRun, dispatcher: ConductorDispatcher): Promise<ConductorOutcome> {
  const decision = await dispatcher.dispatchArbiter(current)
  const malformed = decisionProblem(decision, current)
  if (malformed !== undefined) {
    const run = recordGate(current, {
      decision: 'escalate',
      basis: [malformed],
      evidenceReviewed: [],
      stateUpdate: 'reject malformed arbiter decision',
    })
    return { kind: 'blocked', blocker: malformed, run }
  }
  if (decision.decision === 'go') {
    const run = recordGate(current, {
      decision: 'pass',
      basis: decision.basis,
      evidenceReviewed: decision.evidence_reviewed,
      stateUpdate: 'arbiter GO — move to closeout',
    })
    return { kind: 'decision', decision, run }
  }
  const run = recordGate(current, {
    decision: 'escalate',
    basis: decision.basis,
    evidenceReviewed: decision.evidence_reviewed,
    stateUpdate: 'arbiter NO-GO — escalate to owner',
  })
  return { kind: 'blocked', blocker: 'arbiter returned NO-GO', run }
}

const SPECIALIST_STATUSES: readonly SpecialistStatus[] = ['ready', 'rework', 'blocked', 'failed']
const ARBITER_DECISIONS: readonly ArbiterDecision[] = ['go', 'no-go']

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

/** Structural wire validation for a specialist envelope; returns a reason or undefined. */
function envelopeProblem(envelope: unknown, stage: ConductorStage, run: ConductorRun): string | undefined {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return 'specialist returned no structured envelope'
  }
  const value = envelope as Record<string, unknown>
  if (value['run_id'] !== run.runId) {
    return `envelope run_id does not match ${run.runId}`
  }
  if (value['stage'] !== stage) {
    return `envelope stage does not match dispatched stage ${stage}`
  }
  if (!isOneOf(value['status'], SPECIALIST_STATUSES)) {
    return `envelope status is invalid: ${String(value['status'])}`
  }
  if (!nonEmptyText(value['summary'])) {
    return 'envelope summary must be a non-empty normalized string'
  }
  if (!isArray(value['evidence']) || !isArray(value['findings']) || !isArray(value['assumptions'])
    || !isArray(value['blockers']) || !isArray(value['artifacts']) || !isArray(value['change_requests'])) {
    return 'envelope list fields must be arrays'
  }
  const transition = value['recommended_transition']
  if (typeof transition !== 'object' || transition === null
    || (transition as Record<string, unknown>)['target'] !== 'conductor') {
    return 'envelope recommended_transition must target "conductor"'
  }
  if (value['confidence'] !== undefined && !isOneOf(value['confidence'], ['low', 'medium', 'high'])) {
    return 'envelope confidence is invalid'
  }
  return undefined
}

/** Structural wire validation for an Arbiter decision; returns a reason or undefined. */
function decisionProblem(decision: unknown, run: ConductorRun): string | undefined {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
    return 'arbiter returned no structured decision'
  }
  const value = decision as Record<string, unknown>
  if (value['run_id'] !== run.runId) {
    return `arbiter decision run_id does not match ${run.runId}`
  }
  if (!isOneOf(value['decision'], ARBITER_DECISIONS)) {
    return `arbiter decision is invalid: ${String(value['decision'])}`
  }
  if (!isArray(value['basis']) || !isArray(value['evidence_reviewed'])) {
    return 'arbiter decision basis and evidence_reviewed must be arrays'
  }
  return undefined
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** The first authority change request, when the specialist asked for more authority. */
function authorityChangeRequest(envelope: SpecialistEnvelope): { reason: string } | undefined {
  for (const request of envelope.change_requests) {
    if (request.target === 'authority') return { reason: request.reason }
  }
  return undefined
}

/** Derive a rework defect class from the envelope's change requests, else from the stage. */
function defectClassFromEnvelope(envelope: SpecialistEnvelope, stage: ConductorStage): DefectClass {
  for (const request of envelope.change_requests) {
    switch (request.target) {
      case 'scope':
        return 'scope'
      case 'plan':
      case 'baseline':
        return 'plan'
      case 'authority':
        break
      default:
        assertNever(request.target)
    }
  }
  switch (stage) {
    case 'detective':
      return 'scope'
    case 'strategist':
    case 'devils-advocate':
      return 'plan'
    case 'headsman':
    case 'auditor':
      return 'implementation'
    case 'integrator':
    case 'arbiter':
      return 'delivery'
    case 'intake':
    case 'ralph':
    case 'closeout':
      throw new Error(`stage "${stage}" owns no rework defect class`)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unreachable drive value: ${String(value)}`)
}
