/**
 * Conductor run-state runtime entry point.
 *
 * This package owns the Conductor run and gate vocabulary. The run state
 * machine, gate engine, and persistence land in later tasks; this entry point
 * re-exports the shared types so consumers reach them from the package root.
 * @module @deepseek-ai/dsh-conductor
 */

export { ConductorRunId } from './types.ts'
export type {
  ArbiterDecision,
  ChangeRequest,
  ChangeRequestTarget,
  ConductorAction,
  ConductorAuthority,
  ConductorBudget,
  ConductorRun,
  ConductorRunStatus,
  ConductorStage,
  Confidence,
  DecisionRecord,
  DefectClass,
  EvidenceItem,
  EvidenceKind,
  ExecutionBaseline,
  Finding,
  FindingSeverity,
  GateDecision,
  GateId,
  GateRecord,
  RecommendedTransition,
  SpecialistEnvelope,
  SpecialistStatus,
} from './types.ts'
export { createRun, gateOfStage, nextStageAfterPass, recordGate, reworkCycles, stageOfGate } from './state.ts'
export type { CreateRunInput, GateVerdict } from './state.ts'
export {
  InMemoryConductorRunStore,
  parseRun,
  resumeRun,
  serializeRun,
  validateResumable,
} from './persistence.ts'
export type { ConductorRunStore } from './persistence.ts'
export { decisionForStatus, reworkTarget, routeGate } from './routing.ts'
export type { RoutedGate } from './routing.ts'
export { drive } from './drive.ts'
export type { ConductorDispatcher, ConductorOutcome } from './drive.ts'
export { isValidRunId, mintRunId } from './run-id.ts'
