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
  ConductorRun,
  ConductorRunId,
  ConductorRunStatus,
  ConductorStage,
  DefectClass,
  GateDecision,
  GateId,
} from './types.ts'

const RUN_STATUSES = ['running', 'awaiting_authorization', 'rework', 'escalated', 'closed', 'aborted'] as const satisfies readonly ConductorRunStatus[]
const STAGES = ['intake', 'detective', 'strategist', 'devils-advocate', 'headsman', 'ralph', 'auditor', 'integrator', 'arbiter', 'closeout'] as const satisfies readonly ConductorStage[]
const GATE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const satisfies readonly GateId[]
const GATE_DECISIONS = ['pass', 'rework', 'escalate', 'abort'] as const satisfies readonly GateDecision[]
const DEFECT_CLASSES = ['scope', 'plan', 'implementation', 'delivery'] as const satisfies readonly DefectClass[]

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
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
 * Serialize a run to its durable JSON form.
 * @param run - the run to serialize.
 * @returns the JSON string.
 */
export function serializeRun(run: ConductorRun): string {
  return JSON.stringify(run)
}

/**
 * Parse a durable JSON record back into a run, validating the fields that
 * drive resume correctness — `runId`, `status`, `currentStage`, and every gate
 * record's discriminant tags — at the durable boundary. Remaining nested fields
 * (constraints, authority, baseline) are trusted once the record is typed.
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

  if (typeof record.runId !== 'string' || record.runId === '') {
    throw new Error('Conductor run record has no runId')
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
  }

  return record as unknown as ConductorRun
}

/**
 * Assert a run is resumable. A `closed` or `aborted` run is terminal and never
 * resumes. A resumable run must sit exactly where its documented history put
 * it: with no gate history it may only be at the initial `intake`/`detective`
 * stage; otherwise its `currentStage` must equal the last gate record's
 * `nextStage` (or its `stage` when the decision set no successor).
 * @param run - the run to check.
 */
export function validateResumable(run: ConductorRun): void {
  if (run.status === 'closed' || run.status === 'aborted') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; a terminal run cannot resume`)
  }
  if (run.history.length === 0) {
    if (run.currentStage !== 'intake' && run.currentStage !== 'detective') {
      throw new Error(`Conductor run ${run.runId} has no gate history but is at stage "${run.currentStage}"`)
    }
    return
  }
  const last = run.history.at(-1)
  if (last === undefined) {
    throw new Error(`Conductor run ${run.runId} has no gate history to resume from`)
  }
  const expected = last.nextStage ?? last.stage
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
