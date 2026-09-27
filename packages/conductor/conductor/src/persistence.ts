/**
 * Conductor run persistence and resume.
 *
 * A run is durable state keyed by {@link ConductorRunId}. This module defines
 * the store contract the runtime persists runs through, a JSON wire format for
 * a durable record, and the resume rules: a terminal run (`closed`/`aborted`)
 * is never resumable, and a resumable run's stage must be exactly what its last
 * documented gate produced — undocumented intermediate state is rejected.
 *
 * @module @deepseek-ai/dsh-conductor/persistence
 */

import type {
  ArbiterDecision,
  ConductorAction,
  ConductorCloseoutAction,
  ConductorRun,
  ConductorRunId,
  ConductorRunStatus,
  ConductorStage,
  DefectClass,
  GateDecision,
  GateId,
} from './types.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { isValidRunId } from './run-id.ts'

/** One whole-run checkpoint in the parent Session log. A null record is a tombstone. */
export interface ConductorCheckpointData {
  /** Stable keyed run identity. */
  runId: ConductorRunId
  /** Serialized run snapshot, or null when the key was deleted. */
  record: string | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Commits one complete Conductor run snapshot. Last checkpoint per run id wins.
     * @param data - run id and serialized snapshot or tombstone.
     */
    'conductor/checkpoint': ConductorCheckpointData
  }
}

const RUN_STATUSES = ['running', 'awaiting_authorization', 'rework', 'escalated', 'closed', 'aborted'] as const satisfies readonly ConductorRunStatus[]
const STAGES = ['intake', 'detective', 'strategist', 'devils-advocate', 'headsman', 'ralph', 'auditor', 'integrator', 'arbiter', 'closeout'] as const satisfies readonly ConductorStage[]
const GATE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const satisfies readonly GateId[]
const GATE_DECISIONS = ['pass', 'rework', 'escalate', 'abort'] as const satisfies readonly GateDecision[]
const DEFECT_CLASSES = ['scope', 'plan', 'implementation', 'delivery'] as const satisfies readonly DefectClass[]
const ACTIONS = ['read', 'write', 'commit', 'push', 'merge', 'release', 'publish', 'deploy'] as const satisfies readonly ConductorAction[]
const CLOSEOUT_ACTIONS = ['record-only', ...ACTIONS] as const satisfies readonly ConductorCloseoutAction[]
const ARBITER_DECISIONS = ['go', 'no-go'] as const satisfies readonly ArbiterDecision[]
const SPECIALIST_STATUSES = ['ready', 'rework', 'blocked', 'failed'] as const
const EVIDENCE_KINDS = ['command', 'file', 'test', 'review', 'external'] as const
const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const CHANGE_TARGETS = ['scope', 'plan', 'baseline', 'authority'] as const
const CONFIDENCES = ['low', 'medium', 'high'] as const

const GATE_STAGE: Readonly<Record<GateId, ConductorStage>> = {
  A: 'detective',
  B: 'strategist',
  C: 'devils-advocate',
  D: 'headsman',
  E: 'auditor',
  F: 'integrator',
  G: 'arbiter',
}
const NEXT_AFTER_PASS: Readonly<Record<GateId, ConductorStage>> = {
  A: 'strategist',
  B: 'devils-advocate',
  C: 'headsman',
  D: 'auditor',
  E: 'integrator',
  F: 'arbiter',
  G: 'closeout',
}
const REWORK_STAGE: Readonly<Record<DefectClass, ConductorStage>> = {
  scope: 'detective',
  plan: 'strategist',
  implementation: 'headsman',
  delivery: 'integrator',
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Conductor run record ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Conductor run record ${field} must be a string`)
  return value
}

function requireNormalizedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`Conductor run record ${field} must be a non-empty normalized string`)
  }
  return value
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Conductor run record ${field} must be a string array`)
  }
}

function requireNormalizedStringArray(value: unknown, field: string, distinct = false): asserts value is string[] {
  if (!Array.isArray(value)
    || value.some(item => typeof item !== 'string' || item.length === 0 || item !== item.trim())) {
    throw new Error(`Conductor run record ${field} must contain only non-empty normalized strings`)
  }
  if (distinct && new Set(value).size !== value.length) {
    throw new Error(`Conductor run record ${field} must not contain duplicates`)
  }
}

function validateBaseline(value: unknown): void {
  if (value === null) return
  const baseline = asObject(value, 'baseline')
  requireString(baseline.scopeVersion, 'baseline.scopeVersion')
  requireString(baseline.planVersion, 'baseline.planVersion')
  requireString(baseline.acceptanceVersion, 'baseline.acceptanceVersion')
  requireNormalizedStringArray(baseline.allowedPaths, 'baseline.allowedPaths', true)
  requireNormalizedStringArray(baseline.excludedPaths, 'baseline.excludedPaths', true)
  requireNormalizedString(baseline.rollbackReference, 'baseline.rollbackReference')
}

function validateSpecialistReport(value: unknown, index: number, runId: string): void {
  const prefix = `specialistReports[${index}]`
  const report = asObject(value, prefix)
  if (report.run_id !== runId) throw new Error(`Conductor run record ${prefix}.run_id must match runId`)
  if (!isOneOf(report.stage, STAGES) || report.stage === 'intake' || report.stage === 'ralph'
    || report.stage === 'arbiter' || report.stage === 'closeout') {
    throw new Error(`Conductor run record ${prefix}.stage is invalid`)
  }
  requireString(report.baseline_ref, `${prefix}.baseline_ref`)
  if (report.source_baseline !== undefined) requireString(report.source_baseline, `${prefix}.source_baseline`)
  if (!isOneOf(report.status, SPECIALIST_STATUSES)) throw new Error(`Conductor run record ${prefix}.status is invalid`)
  requireString(report.summary, `${prefix}.summary`)
  if (!Array.isArray(report.evidence)) throw new Error(`Conductor run record ${prefix}.evidence must be an array`)
  for (const [evidenceIndex, item] of report.evidence.entries()) {
    const evidence = asObject(item, `${prefix}.evidence[${evidenceIndex}]`)
    if (!isOneOf(evidence.kind, EVIDENCE_KINDS)) throw new Error(`Conductor run record ${prefix}.evidence kind is invalid`)
    requireString(evidence.reference, `${prefix}.evidence.reference`)
    requireString(evidence.outcome, `${prefix}.evidence.outcome`)
  }
  if (!Array.isArray(report.findings)) throw new Error(`Conductor run record ${prefix}.findings must be an array`)
  for (const [findingIndex, item] of report.findings.entries()) {
    const finding = asObject(item, `${prefix}.findings[${findingIndex}]`)
    requireString(finding.id, `${prefix}.findings.id`)
    if (!isOneOf(finding.severity, FINDING_SEVERITIES)) throw new Error(`Conductor run record ${prefix}.finding severity is invalid`)
    requireString(finding.description, `${prefix}.findings.description`)
    requireString(finding.impact, `${prefix}.findings.impact`)
  }
  requireStringArray(report.assumptions, `${prefix}.assumptions`)
  requireStringArray(report.blockers, `${prefix}.blockers`)
  requireStringArray(report.artifacts, `${prefix}.artifacts`)
  if (!Array.isArray(report.change_requests)) throw new Error(`Conductor run record ${prefix}.change_requests must be an array`)
  for (const [requestIndex, item] of report.change_requests.entries()) {
    const request = asObject(item, `${prefix}.change_requests[${requestIndex}]`)
    if (!isOneOf(request.target, CHANGE_TARGETS)) throw new Error(`Conductor run record ${prefix}.change request target is invalid`)
    requireString(request.reason, `${prefix}.change_requests.reason`)
    requireString(request.impact, `${prefix}.change_requests.impact`)
  }
  if (report.execution_baseline !== undefined) validateBaseline(report.execution_baseline)
  const transition = asObject(report.recommended_transition, `${prefix}.recommended_transition`)
  if (transition.target !== 'conductor') throw new Error(`Conductor run record ${prefix} must return to conductor`)
  requireString(transition.rationale, `${prefix}.recommended_transition.rationale`)
  if (!isOneOf(report.confidence, CONFIDENCES)) throw new Error(`Conductor run record ${prefix}.confidence is invalid`)
}

function validateDecision(value: unknown): void {
  const decision = asObject(value, 'decision')
  requireNormalizedString(decision.run_id, 'decision.run_id')
  if (!isOneOf(decision.decision, ARBITER_DECISIONS)) {
    throw new Error(`Conductor run record has invalid decision.decision: ${String(decision.decision)}`)
  }
  requireNormalizedStringArray(decision.basis, 'decision.basis')
  requireNormalizedStringArray(decision.evidence_reviewed, 'decision.evidence_reviewed')
  requireNormalizedStringArray(decision.conditions, 'decision.conditions')
  requireNormalizedStringArray(decision.open_risks, 'decision.open_risks')
  requireNormalizedStringArray(decision.required_follow_up, 'decision.required_follow_up')
  if (decision.decision === 'go'
    && (decision.basis.length === 0 || decision.evidence_reviewed.length === 0)) {
    throw new Error('Conductor run record Arbiter GO requires a non-empty basis and reviewed evidence')
  }
}

function validateTraceability(value: unknown, field: string): void {
  const traceability = asObject(value, field)
  requireNormalizedStringArray(traceability.mandate, `${field}.mandate`)
  requireNormalizedStringArray(traceability.baseline, `${field}.baseline`)
  requireNormalizedStringArray(traceability.changes, `${field}.changes`)
  requireNormalizedStringArray(traceability.verification, `${field}.verification`)
  requireNormalizedStringArray(traceability.decision, `${field}.decision`)
}

function validateCloseout(value: unknown): void {
  const closeout = asObject(value, 'closeout')
  requireNormalizedString(closeout.run_id, 'closeout.run_id')
  if (closeout.arbiter_decision !== 'go') throw new Error('Conductor run record closeout.arbiter_decision must be "go"')
  requireNormalizedString(closeout.authorized_by, 'closeout.authorized_by')
  if (!isOneOf(closeout.authorized_action, CLOSEOUT_ACTIONS)) {
    throw new Error(`Conductor run record has invalid closeout.authorized_action: ${String(closeout.authorized_action)}`)
  }
  requireNormalizedStringArray(closeout.actions_taken, 'closeout.actions_taken')
  requireNormalizedStringArray(closeout.outcome_evidence, 'closeout.outcome_evidence')
  requireNormalizedStringArray(closeout.unverified_items, 'closeout.unverified_items')
  requireNormalizedStringArray(closeout.open_risks, 'closeout.open_risks')
  if (closeout.outcome_evidence.length === 0) {
    throw new Error('Conductor run record closeout.outcome_evidence must not be empty')
  }
  if (!Array.isArray(closeout.follow_up)) throw new Error('Conductor run record closeout.follow_up must be an array')
  for (const [index, item] of closeout.follow_up.entries()) {
    const followUp = asObject(item, `closeout.follow_up[${index}]`)
    requireNormalizedString(followUp.owner, `closeout.follow_up[${index}].owner`)
    requireNormalizedString(followUp.due_condition, `closeout.follow_up[${index}].due_condition`)
  }
  validateTraceability(closeout.traceability, 'closeout.traceability')
  if (closeout.status !== 'closed') throw new Error('Conductor run record closeout.status must be "closed"')
}

/**
 * A keyed store of Conductor runs. Implementations may be in-memory (tests) or
 * durable (a storage backend or a session-log projection); the contract is
 * keyed by {@link ConductorRunId} and owns no gate semantics.
 */
export interface ConductorRunStore {
  /**
   * Persist one run under its {@link ConductorRun.runId}, replacing any
   * previous record for that id.
   * @param run - the run to persist.
   */
  save(run: ConductorRun): Promise<void>
  /**
   * Read a persisted run.
   * @param runId - the run id to read.
   * @returns the run, or undefined when no record exists for the id.
   */
  load(runId: ConductorRunId): Promise<ConductorRun | undefined>
  /**
   * Remove a persisted run. Idempotent: a missing id is a no-op.
   * @param runId - the run id to remove.
   */
  delete(runId: ConductorRunId): Promise<void>
}

/**
 * In-memory {@link ConductorRunStore} that round-trips each run through the
 * JSON wire format, so save/load exercise {@link serializeRun}/{@link parseRun}
 * and never alias a caller's live object.
 */
export class InMemoryConductorRunStore implements ConductorRunStore {
  private readonly records = new Map<string, string>()

  save(run: ConductorRun): Promise<void> {
    this.records.set(run.runId, serializeRun(run))
    return Promise.resolve()
  }

  load(runId: ConductorRunId): Promise<ConductorRun | undefined> {
    const json = this.records.get(runId)
    return Promise.resolve(json === undefined ? undefined : parseRun(json))
  }

  delete(runId: ConductorRunId): Promise<void> {
    this.records.delete(runId)
    return Promise.resolve()
  }
}

/**
 * Session-log-backed run store. Every save appends a whole-run checkpoint and
 * waits for the caller-supplied session flush, so a later process can fold the
 * same durable log without relying on live process memory.
 */
export class SessionConductorRunStore implements ConductorRunStore {
  /**
   * @param session - calling parent Session that owns the durable checkpoints.
   * @param flush - persists the Session through its configured backend.
   */
  constructor(
    private readonly session: Session,
    private readonly flush: () => Promise<void>,
  ) {}

  async save(run: ConductorRun): Promise<void> {
    this.session.append('conductor/checkpoint', { runId: run.runId, record: serializeRun(run) })
    await this.flush()
  }

  load(runId: ConductorRunId): Promise<ConductorRun | undefined> {
    for (let index = this.session.events.length - 1; index >= 0; index -= 1) {
      const event = this.session.events[index]
      if (event?.type !== 'conductor/checkpoint' || event.data.runId !== runId) continue
      return Promise.resolve(event.data.record === null ? undefined : parseRun(event.data.record))
    }
    return Promise.resolve(undefined)
  }

  async delete(runId: ConductorRunId): Promise<void> {
    this.session.append('conductor/checkpoint', { runId, record: null })
    await this.flush()
  }
}

/**
 * Serialize a run to its durable JSON form.
 * @param run - the run to serialize.
 * @returns the JSON string.
 */
export function serializeRun(run: ConductorRun): string {
  return JSON.stringify(run)
}

/**
 * Parse a durable JSON record back into a run. Every run field and nested
 * record used after resume is validated at this durable boundary; same-process
 * TypeScript types are not trusted after JSON persistence.
 * @param json - the serialized run.
 * @returns the parsed run.
 */
export function parseRun(json: string): ConductorRun {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (cause) {
    throw new Error('Conductor run record is not valid JSON', { cause })
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Conductor run record must be a JSON object')
  }
  const record = raw as Record<string, unknown>

  if (typeof record.runId !== 'string' || !isValidRunId(record.runId)) {
    throw new Error(`Conductor run record has invalid runId: ${String(record.runId)}`)
  }
  requireNormalizedString(record.objective, 'objective')
  requireNormalizedStringArray(record.scope, 'scope', true)
  requireNormalizedStringArray(record.inputArtifacts, 'inputArtifacts', true)
  requireNormalizedStringArray(record.allowedPaths, 'allowedPaths', true)
  requireNormalizedStringArray(record.excludedPaths, 'excludedPaths', true)
  if (record.sourceBaseline !== null) {
    requireNormalizedString(record.sourceBaseline, 'sourceBaseline')
  }
  const authority = asObject(record.authority, 'authority')
  requireNormalizedString(authority.owner, 'authority.owner')
  if (!Array.isArray(authority.permittedActions)
    || authority.permittedActions.some(action => !isOneOf(action, ACTIONS))) {
    throw new Error('Conductor run record authority.permittedActions contains an invalid action')
  }
  if (new Set(authority.permittedActions).size !== authority.permittedActions.length) {
    throw new Error('Conductor run record authority.permittedActions must not contain duplicates')
  }
  requireNormalizedStringArray(record.constraints, 'constraints', true)
  requireNormalizedStringArray(record.acceptanceCriteria, 'acceptanceCriteria', true)
  const budget = asObject(record.budget, 'budget')
  if (!Number.isSafeInteger(budget.maxReworkCycles) || Number(budget.maxReworkCycles) < 1) {
    throw new Error('Conductor run record budget.maxReworkCycles must be a positive safe integer')
  }
  if (!Number.isSafeInteger(budget.maxRalphRounds) || Number(budget.maxRalphRounds) < 0) {
    throw new Error('Conductor run record budget.maxRalphRounds must be a non-negative safe integer')
  }
  validateBaseline(record.baseline)
  if (record.baseline !== null) {
    const baseline = record.baseline as Record<string, unknown>
    if (JSON.stringify(baseline.allowedPaths) !== JSON.stringify(record.allowedPaths)
      || JSON.stringify(baseline.excludedPaths) !== JSON.stringify(record.excludedPaths)) {
      throw new Error('Conductor run record baseline paths must match the owner-authorized run paths')
    }
  }
  if (!isOneOf(record.status, RUN_STATUSES)) {
    throw new Error(`Conductor run record has invalid status: ${String(record.status)}`)
  }
  if (!isOneOf(record.currentStage, STAGES)) {
    throw new Error(`Conductor run record has invalid currentStage: ${String(record.currentStage)}`)
  }
  if (!Array.isArray(record.history)) {
    throw new Error('Conductor run record history must be an array')
  }
  for (const entry of record.history) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Conductor run history entry must be an object')
    }
    const gate = entry as Record<string, unknown>
    if (!isOneOf(gate.gate, GATE_IDS)) {
      throw new Error(`Conductor gate record has invalid gate: ${String(gate.gate)}`)
    }
    if (!isOneOf(gate.stage, STAGES)) {
      throw new Error(`Conductor gate record has invalid stage: ${String(gate.stage)}`)
    }
    if (!isOneOf(gate.decision, GATE_DECISIONS)) {
      throw new Error(`Conductor gate record has invalid decision: ${String(gate.decision)}`)
    }
    if (gate.defectClass !== undefined && !isOneOf(gate.defectClass, DEFECT_CLASSES)) {
      throw new Error(`Conductor gate record has invalid defectClass: ${JSON.stringify(gate.defectClass)}`)
    }
    if (gate.nextStage !== undefined && !isOneOf(gate.nextStage, STAGES)) {
      throw new Error(`Conductor gate record has invalid nextStage: ${JSON.stringify(gate.nextStage)}`)
    }
    requireStringArray(gate.basis, 'history.basis')
    requireStringArray(gate.evidenceReviewed, 'history.evidenceReviewed')
    requireString(gate.stateUpdate, 'history.stateUpdate')
    if (GATE_STAGE[gate.gate] !== gate.stage) {
      throw new Error(`Conductor gate ${gate.gate} cannot belong to stage ${gate.stage}`)
    }
    if (gate.decision === 'pass' && gate.nextStage !== NEXT_AFTER_PASS[gate.gate]) {
      throw new Error(`Conductor gate ${gate.gate} pass has invalid nextStage`)
    }
    if (gate.decision === 'rework') {
      if (!isOneOf(gate.defectClass, DEFECT_CLASSES) || gate.nextStage !== REWORK_STAGE[gate.defectClass]) {
        throw new Error(`Conductor gate ${gate.gate} rework has invalid defectClass or nextStage`)
      }
    }
    if (gate.decision === 'abort' && (gate.nextStage !== undefined || gate.defectClass !== undefined)) {
      throw new Error(`Conductor gate ${gate.gate} abort cannot carry rework routing`)
    }
  }

  if (!Array.isArray(record.specialistReports)) {
    throw new Error('Conductor run record specialistReports must be an array')
  }
  for (const [index, report] of record.specialistReports.entries()) {
    validateSpecialistReport(report, index, record.runId)
  }

  if (record.decision !== undefined) validateDecision(record.decision)
  if (record.closeout !== undefined) validateCloseout(record.closeout)
  const decision = record.decision as Record<string, unknown> | undefined
  const closeout = record.closeout as Record<string, unknown> | undefined
  if (decision !== undefined && decision.run_id !== record.runId) {
    throw new Error('Conductor run record decision.run_id must match runId')
  }
  if (closeout !== undefined && closeout.run_id !== record.runId) {
    throw new Error('Conductor run record closeout.run_id must match runId')
  }
  if (closeout !== undefined && closeout.authorized_by !== authority.owner) {
    throw new Error('Conductor run record closeout.authorized_by must match authority.owner')
  }
  if (closeout !== undefined && closeout.authorized_action !== 'record-only'
    && !authority.permittedActions.includes(closeout.authorized_action)) {
    throw new Error('Conductor run record closeout.authorized_action is outside the run authority')
  }
  if (record.status === 'awaiting_authorization'
    && (record.currentStage !== 'closeout' || decision?.decision !== 'go')) {
    throw new Error('Conductor run awaiting authorization requires closeout stage and an Arbiter GO')
  }
  if (record.status === 'closed'
    && (record.currentStage !== 'closeout' || decision?.decision !== 'go' || closeout === undefined)) {
    throw new Error('Closed Conductor run requires closeout stage, Arbiter GO, and closeout record')
  }
  const lastGate = record.history.at(-1) as Record<string, unknown> | undefined
  if (lastGate !== undefined) {
    const expectedStatus = lastGate.decision === 'pass'
      ? (lastGate.gate === 'G' ? 'awaiting_authorization' : 'running')
      : lastGate.decision === 'rework'
        ? 'rework'
        : lastGate.decision === 'escalate'
          ? 'escalated'
          : 'aborted'
    if (record.status !== expectedStatus && !(record.status === 'closed' && expectedStatus === 'awaiting_authorization')) {
      throw new Error(`Conductor run record status ${record.status} does not match last gate decision`)
    }
  }

  return record as unknown as ConductorRun
}

/**
 * Assert a run is resumable. A `closed` or `aborted` run is terminal and never
 * resumes. A resumable run must sit exactly where its documented history put
 * it: with no gate history it may only be at the initial `intake`/`detective`
 * stage; otherwise every history entry must continue from its predecessor and
 * `currentStage` must equal the last documented successor.
 * @param run - the run to check.
 */
export function validateResumable(run: ConductorRun): void {
  if (run.status === 'closed' || run.status === 'aborted') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; a terminal run cannot resume`)
  }
  if (run.status === 'escalated') {
    throw new Error(`Conductor run ${run.runId} is escalated; an owner resolution is required before resume`)
  }
  if (run.history.length === 0) {
    if (run.currentStage !== 'intake' && run.currentStage !== 'detective') {
      throw new Error(`Conductor run ${run.runId} has no gate history but is at stage "${run.currentStage}"`)
    }
    return
  }
  let expected: ConductorStage = 'detective'
  for (const gate of run.history) {
    if (gate.stage !== expected) {
      throw new Error(
        `Conductor run ${run.runId} history jumps to gate ${gate.gate} at "${gate.stage}" (expected "${expected}")`,
      )
    }
    expected = gate.nextStage ?? gate.stage
  }
  const last = run.history.at(-1)
  if (last === undefined) throw new Error(`Conductor run ${run.runId} has no gate history to resume from`)
  if (run.currentStage !== expected) {
    throw new Error(
      `Conductor run ${run.runId} stage "${run.currentStage}" does not match last gate ${last.gate} (expected "${expected}")`,
    )
  }
}

/**
 * Load a run and return it only if it is resumable.
 * @param store - the store to read from.
 * @param runId - the run id to resume.
 * @returns the run at its last documented, valid state.
 */
export async function resumeRun(store: ConductorRunStore, runId: ConductorRunId): Promise<ConductorRun> {
  const run = await store.load(runId)
  if (run === undefined) {
    throw new Error(`Conductor run ${runId} not found; cannot resume`)
  }
  validateResumable(run)
  return run
}
