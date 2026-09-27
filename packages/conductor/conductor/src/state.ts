/**
 * Conductor run state machine and gate engine.
 *
 * Conductor is the only owner of a run's workflow state. This module owns the
 * gate sequence (A through G), derives each gate letter from the run's current
 * stage, appends the resulting {@link GateRecord}, and advances the run's
 * stage and status. A specialist never mutates the run and never chooses the
 * next stage; {@link recordGate} is the single transition point.
 *
 * @module @deepseek-ai/dsh-conductor/state
 */

import type {
  ConductorAuthority,
  ConductorBudget,
  CloseoutAuthorization,
  CloseoutRecord,
  ConductorRun,
  ConductorRunId,
  ConductorRunStatus,
  ConductorStage,
  DefectClass,
  GateDecision,
  GateId,
  GateRecord,
} from './types.ts'

/**
 * The initial, dispatch-ready run state. The run starts at `detective` with an
 * empty gate history and no execution baseline (baseline lands after Gate C).
 */
export interface CreateRunInput {
  /** The desired outcome. */
  objective: string
  /** Files, components, or concerns included in the run. */
  scope?: string[]
  /** Artifacts supplied at intake. */
  inputArtifacts?: string[]
  /** Owner-authorized roots that write-capable stages may modify. */
  allowedPaths?: string[]
  /** Owner-declared roots excluded from every specialist write. */
  excludedPaths?: string[]
  /** Source state observed at intake, when already known. */
  sourceBaseline?: string
  /** The mandate owner and permitted external actions. */
  authority: ConductorAuthority
  /** Non-negotiable constraints on the work. */
  constraints?: string[]
  /** The measurable criteria each gate's pass is judged against. */
  acceptanceCriteria?: string[]
  /** Rework and Ralph round limits; defaults to `{ maxReworkCycles: 3, maxRalphRounds: 0 }`. */
  budget?: ConductorBudget
}

/**
 * Build a fresh, dispatch-ready run at the Detective stage.
 * @param runId - the minted run id.
 * @param input - the mandate that bounds the run.
 * @returns the initial run.
 */
export function createRun(runId: ConductorRunId, input: CreateRunInput): ConductorRun {
  return {
    runId,
    objective: input.objective,
    scope: input.scope ?? [],
    inputArtifacts: input.inputArtifacts ?? [],
    allowedPaths: input.allowedPaths ?? [],
    excludedPaths: input.excludedPaths ?? [],
    sourceBaseline: input.sourceBaseline ?? null,
    authority: input.authority,
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    budget: input.budget ?? { maxReworkCycles: 3, maxRalphRounds: 0 },
    baseline: null,
    currentStage: 'detective',
    history: [],
    specialistReports: [],
    status: 'running',
  }
}

const GATE_OF_STAGE: Record<ConductorStage, GateId | undefined> = {
  intake: undefined,
  detective: 'A',
  strategist: 'B',
  'devils-advocate': 'C',
  headsman: 'D',
  ralph: undefined,
  auditor: 'E',
  integrator: 'F',
  arbiter: 'G',
  closeout: undefined,
}

const STAGE_OF_GATE: Record<GateId, ConductorStage> = {
  A: 'detective',
  B: 'strategist',
  C: 'devils-advocate',
  D: 'headsman',
  E: 'auditor',
  F: 'integrator',
  G: 'arbiter',
}

const NEXT_AFTER_PASS: Partial<Record<ConductorStage, ConductorStage>> = {
  detective: 'strategist',
  strategist: 'devils-advocate',
  'devils-advocate': 'headsman',
  headsman: 'auditor',
  auditor: 'integrator',
  integrator: 'arbiter',
  arbiter: 'closeout',
}

/**
 * The gate letter a stage owns, or undefined for non-gated stages
 * (`intake`, `ralph`, `closeout`).
 * @param stage - the stage to look up.
 * @returns the gate letter, or undefined when the stage owns no gate.
 */
export function gateOfStage(stage: ConductorStage): GateId | undefined {
  return GATE_OF_STAGE[stage]
}

/**
 * The gated stage a gate letter decides.
 * @param gate - the gate letter (A through G).
 * @returns the corresponding stage.
 */
export function stageOfGate(gate: GateId): ConductorStage {
  return STAGE_OF_GATE[gate]
}

/**
 * The stage a `pass` at `stage`'s gate advances to. The linear pass path is
 * Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator →
 * Arbiter → closeout.
 * @param stage - the current gated stage.
 * @returns the next stage, or undefined when `stage` has no pass successor.
 */
export function nextStageAfterPass(stage: ConductorStage): ConductorStage | undefined {
  return NEXT_AFTER_PASS[stage]
}

/**
 * How many rework decisions this run has already recorded.
 * @param run - the run to count.
 * @returns the number of {@link GateRecord} entries with decision `rework`.
 */
export function reworkCycles(run: ConductorRun): number {
  let count = 0
  for (const record of run.history) {
    if (record.decision === 'rework') count += 1
  }
  return count
}

/**
 * One gate decision as Conductor records it, before the engine derives the
 * gate letter and the terminal/pass transitions. `defectClass` and `nextStage`
 * are required for a `rework` (within budget); `nextStage` is optional for an
 * explicit `escalate` and ignored for `pass`/`abort`.
 */
export interface GateVerdict {
  /** Conductor's decision. */
  decision: GateDecision
  /** The concrete evidence and reasoning behind the decision. */
  basis: string[]
  /** The artifacts and outputs reviewed at this gate. */
  evidenceReviewed: string[]
  /** For `rework`: the defect class routing the fix to the right stage. */
  defectClass?: DefectClass
  /** The stage to route next; required for `rework`, optional for `escalate`. */
  nextStage?: ConductorStage
  /** Short, concrete description of the run-state change this decision applies. */
  stateUpdate: string
}

/**
 * Record one gate decision against the run's current stage and advance state.
 * The gate letter is derived from {@link ConductorRun.currentStage}; a
 * specialist cannot name it. A `pass` advances along the linear pass path; a
 * `rework` within {@link ConductorBudget.maxReworkCycles} routes to the
 * supplied target; a `rework` past that budget is recorded as `escalate`
 * instead of silently reworking again.
 *
 * The returned run is a new value — the input run is never mutated.
 * @param run - the run to transition (must not be `closed` or `aborted`).
 * @param verdict - the decision to record.
 * @returns the updated run with the record appended to `history`.
 */
export function recordGate(run: ConductorRun, verdict: GateVerdict): ConductorRun {
  if (run.status === 'closed' || run.status === 'aborted') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; no further gate decisions`)
  }

  const gate = gateOfStage(run.currentStage)
  if (gate === undefined) {
    throw new Error(`Conductor stage "${run.currentStage}" owns no gate; cannot record a gate decision`)
  }

  let decision: GateDecision = verdict.decision
  let nextStage: ConductorStage | undefined

  switch (verdict.decision) {
    case 'pass':
      nextStage = nextStageAfterPass(run.currentStage)
      break
    case 'rework': {
      if (verdict.defectClass === undefined) {
        throw new Error(`Conductor gate ${gate} rework requires a defect class`)
      }
      if (verdict.nextStage === undefined) {
        throw new Error(`Conductor gate ${gate} rework requires a rework target stage`)
      }
      nextStage = verdict.nextStage
      if (reworkCycles(run) >= run.budget.maxReworkCycles) {
        decision = 'escalate'
      }
      break
    }
    case 'escalate':
      nextStage = verdict.nextStage
      break
    case 'abort':
      nextStage = undefined
      break
    default:
      assertNever(verdict.decision)
  }

  let status: ConductorRunStatus
  switch (decision) {
    case 'pass':
      status = gate === 'G' ? 'awaiting_authorization' : 'running'
      break
    case 'rework':
      status = 'rework'
      break
    case 'escalate':
      status = 'escalated'
      break
    case 'abort':
      status = 'aborted'
      break
    default:
      assertNever(decision)
  }

  const record: GateRecord = {
    gate,
    stage: run.currentStage,
    decision,
    basis: verdict.basis,
    evidenceReviewed: verdict.evidenceReviewed,
    stateUpdate: verdict.stateUpdate,
  }
  if (decision === 'rework' && verdict.defectClass !== undefined) {
    record.defectClass = verdict.defectClass
  }
  if (nextStage !== undefined) {
    record.nextStage = nextStage
  }

  return {
    ...run,
    ...decision === 'rework' && (verdict.defectClass === 'scope' || verdict.defectClass === 'plan')
      ? { baseline: null }
      : {},
    currentStage: nextStage ?? run.currentStage,
    status,
    history: [...run.history, record],
  }
}

/**
 * Close a run after Gate G from an explicit mandate-owner authorization.
 * This function records an already-authorized action and evidence; it never
 * executes commit, push, merge, deploy, or any other external side effect.
 * @param run - a GO run parked at closeout.
 * @param authorization - explicit owner authorization and outcome evidence.
 * @returns a new terminal run carrying its closeout record.
 */
export function closeRun(run: ConductorRun, authorization: CloseoutAuthorization): ConductorRun {
  if (run.currentStage !== 'closeout' || run.status !== 'awaiting_authorization') {
    throw new Error(`Conductor run ${run.runId} is not awaiting closeout authorization`)
  }
  if (run.decision?.decision !== 'go') {
    throw new Error(`Conductor run ${run.runId} has no recorded Arbiter GO`)
  }
  if (authorization.authorizedBy !== run.authority.owner) {
    throw new Error(`closeout authorization must come from mandate owner "${run.authority.owner}"`)
  }
  if (authorization.action !== 'record-only'
    && !run.authority.permittedActions.includes(authorization.action)) {
    throw new Error(`closeout action "${authorization.action}" is outside the run authority`)
  }
  if (authorization.outcomeEvidence.length === 0
    || authorization.outcomeEvidence.some(item => item.length === 0 || item !== item.trim())) {
    throw new Error('closeout authorization requires normalized outcome evidence')
  }
  const normalizedLists = [
    authorization.actionsTaken,
    authorization.unverifiedItems,
    authorization.openRisks,
    authorization.traceability.mandate,
    authorization.traceability.baseline,
    authorization.traceability.changes,
    authorization.traceability.verification,
    authorization.traceability.decision,
  ]
  if (normalizedLists.some(items => items.some(item => item.length === 0 || item !== item.trim()))) {
    throw new Error('closeout authorization lists must contain normalized strings')
  }
  if (authorization.followUp.some(item => item.owner.length === 0
    || item.owner !== item.owner.trim()
    || item.dueCondition.length === 0
    || item.dueCondition !== item.dueCondition.trim())) {
    throw new Error('closeout follow-up requires a normalized owner and due condition')
  }
  const closeout: CloseoutRecord = {
    run_id: run.runId,
    arbiter_decision: 'go',
    authorized_by: authorization.authorizedBy,
    authorized_action: authorization.action,
    actions_taken: [...authorization.actionsTaken],
    outcome_evidence: [...authorization.outcomeEvidence],
    unverified_items: [...authorization.unverifiedItems],
    open_risks: [...authorization.openRisks],
    follow_up: authorization.followUp.map(item => ({
      owner: item.owner,
      due_condition: item.dueCondition,
    })),
    traceability: {
      mandate: [...authorization.traceability.mandate],
      baseline: [...authorization.traceability.baseline],
      changes: [...authorization.traceability.changes],
      verification: [...authorization.traceability.verification],
      decision: [...authorization.traceability.decision],
    },
    status: 'closed',
  }
  return { ...run, status: 'closed', closeout }
}

function assertNever(value: never): never {
  throw new Error(`Unreachable gate decision: ${String(value)}`)
}
