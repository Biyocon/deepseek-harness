/**
 * Conductor run and gate vocabulary: the durable run record, the stage and
 * gate decision types, and the two wire records a specialist returns (the
 * {@link SpecialistEnvelope} and the Arbiter's {@link DecisionRecord}).
 *
 * Internal run state is camelCase; the specialist wire records stay snake_case
 * because they match the YAML the model writes (see the `conductor-specialist`
 * and `conductor-closeout` skills). Types only, plus the id-brand factory, per
 * the package convention.
 *
 * @module @deepseek-ai/dsh-conductor/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one Conductor run. The runtime mints `CON-YYYY-NNNN`; every
 * specialist dispatch, gate record, and the closeout record key off this id.
 */
export type ConductorRunId = Branded<'ConductorRunId'>

/**
 * Brand a string as a {@link ConductorRunId}.
 * @param id - the raw run-id string (`CON-YYYY-NNNN`).
 * @returns the same string, branded; no validation is performed.
 */
export function ConductorRunId(id: string): ConductorRunId {
  return id as ConductorRunId
}

/**
 * Where a run is in its lifecycle. The seven gated stages — `detective`
 * through `arbiter` — each map to exactly one gate (A through G). The
 * remaining values are not gates: `intake` precedes Gate A, `closeout` follows
 * Gate G, and `ralph` is a Headsman-internal iteration sub-phase that never
 * owns a gate.
 */
export type ConductorStage =
  | 'intake'
  | 'detective'
  | 'strategist'
  | 'devils-advocate'
  | 'headsman'
  | 'ralph'
  | 'auditor'
  | 'integrator'
  | 'arbiter'
  | 'closeout'

/**
 * An external action a run's {@link ConductorAuthority} may permit. Every value
 * is negative-space: a GO from The Arbiter grants none of them; only the
 * mandate owner's explicit authority does.
 */
export type ConductorAction = 'read' | 'write' | 'commit' | 'push' | 'merge' | 'release' | 'publish' | 'deploy'

/**
 * Who owns the mandate and which external actions they permit. The permitted
 * actions bound every specialist stage and the closeout release step.
 */
export interface ConductorAuthority {
  /** The mandate owner: a human, the initiating agent ('emperor'), or another named owner. */
  owner: string
  /** External actions the owner has authorized for this run. */
  permittedActions: ConductorAction[]
}

/**
 * Resource limits the Conductor enforces across a run: how many times a stage
 * may be reworked and how many fresh-worker Ralph rounds Headsman may run.
 */
export interface ConductorBudget {
  /** Maximum rework cycles before the run must escalate or abort. */
  maxReworkCycles: number
  /** Maximum Ralph iterations Headsman may run inside one approved baseline. */
  maxRalphRounds: number
}

/**
 * The immutable execution baseline Conductor records after Gate C. Headsman
 * implements against exactly this scope, plan, and acceptance version; a
 * material deviation returns as a change request instead of silently widening
 * the run.
 */
export interface ExecutionBaseline {
  /** Version of the Detective-approved scope. */
  scopeVersion: string
  /** Version of the Strategist-approved plan. */
  planVersion: string
  /** Version of the acceptance criteria the Auditor verifies against. */
  acceptanceVersion: string
  /** Paths Headsman is authorized to write. */
  allowedPaths: string[]
  /** Paths excluded from every write regardless of `allowedPaths`. */
  excludedPaths: string[]
  /** Reference that locates the state to roll back to if execution fails. */
  rollbackReference: string
}

/**
 * One run's lifecycle status. `closed` and `aborted` are terminal; resume is
 * rejected for both. `rework` and `escalated` mark a run parked on a gate
 * decision that needs a fix or an owner decision; `awaiting_authorization`
 * marks a GO whose release action still lacks explicit authority.
 */
export type ConductorRunStatus =
  | 'running'
  | 'awaiting_authorization'
  | 'rework'
  | 'escalated'
  | 'closed'
  | 'aborted'

/**
 * The durable, authoritative record of one Conductor run. Conductor is the only
 * owner of this state: specialists return envelopes, never mutate the run, and
 * never choose the next stage. `history` holds every gate decision so The
 * Arbiter can review the full record.
 */
export interface ConductorRun {
  /** The run's id. */
  runId: ConductorRunId
  /** The desired outcome. */
  objective: string
  /** The files, components, or concerns included in the run. */
  scope: string[]
  /** Artifacts supplied at intake and available to every specialist. */
  inputArtifacts: string[]
  /** Owner-authorized roots that write-capable stages may modify. */
  allowedPaths: string[]
  /** Owner-declared roots excluded from every specialist write. */
  excludedPaths: string[]
  /** Source state observed at intake; Detective may establish it when absent. */
  sourceBaseline: string | null
  /** The mandate owner and permitted external actions. */
  authority: ConductorAuthority
  /** Non-negotiable constraints on the work. */
  constraints: string[]
  /** The measurable criteria each gate's pass is judged against. */
  acceptanceCriteria: string[]
  /** Rework and Ralph round limits. */
  budget: ConductorBudget
  /** The immutable execution baseline; null until Gate C passes. */
  baseline: ExecutionBaseline | null
  /** The stage the run is currently at. */
  currentStage: ConductorStage
  /** Every gate decision recorded so far, in order. */
  history: GateRecord[]
  /** Validated specialist envelopes retained for downstream handoffs and Arbiter review. */
  specialistReports: SpecialistEnvelope[]
  /** The run's lifecycle status. */
  status: ConductorRunStatus
  /** The Arbiter decision recorded at Gate G, when reached. */
  decision?: DecisionRecord
  /** The explicit, record-only closeout authorization and evidence, when closed. */
  closeout?: CloseoutRecord
}

/** The seven gates A–G, one per gated stage (Detective through Arbiter). */
export type GateId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

/**
 * Conductor's decision at a gate — distinct from a specialist's envelope
 * `status`. `pass` requires fresh evidence against the acceptance criteria;
 * `rework` routes a known, bounded fix to the responsible stage; `escalate`
 * defers to the mandate owner; `abort` stops the run.
 */
export type GateDecision = 'pass' | 'rework' | 'escalate' | 'abort'

/** The class of defect a rework addresses, used to route the fix to the right stage. */
export type DefectClass = 'scope' | 'plan' | 'implementation' | 'delivery'

/**
 * One recorded gate decision. Conductor owns this record and appends it to
 * {@link ConductorRun.history}; a specialist's `status` is never recorded as a
 * decision. `defectClass` is set on `rework`; `nextStage` is set on `pass`,
 * `rework`, and `escalate` but absent on `abort`.
 */
export interface GateRecord {
  /** The gate letter. */
  gate: GateId
  /** The gated stage this gate judged (one of the seven Detective–Arbiter stages). */
  stage: ConductorStage
  /** Conductor's decision. */
  decision: GateDecision
  /** The concrete evidence and reasoning behind the decision. */
  basis: string[]
  /** The artifacts and outputs reviewed at this gate. */
  evidenceReviewed: string[]
  /** For `rework`: the class of defect the fix addresses. */
  defectClass?: DefectClass
  /** The stage Conductor routes to next; set on `pass`, `rework`, and `escalate`. */
  nextStage?: ConductorStage
  /** Short, concrete description of the run-state change this decision applies. */
  stateUpdate: string
}

/** A specialist's delivery readiness — never a gate pass (Conductor decides that). */
export type SpecialistStatus = 'ready' | 'rework' | 'blocked' | 'failed'

/** The kind of evidence an item points to. */
export type EvidenceKind = 'command' | 'file' | 'test' | 'review' | 'external'

/** One piece of evidence a specialist cites: a command, file, test, review, or external source. */
export interface EvidenceItem {
  /** What kind of evidence this is. */
  kind: EvidenceKind
  /** The path, command, or identifier that locates the evidence. */
  reference: string
  /** What the evidence shows. */
  outcome: string
}

/** Finding severity, from `low` to `critical`. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'

/** One finding tied to concrete evidence. */
export interface Finding {
  /** Stable finding id (for example `DET-001`). */
  id: string
  /** How severe the finding is. */
  severity: FindingSeverity
  /** The concrete finding. */
  description: string
  /** Why the finding matters. */
  impact: string
}

/** What a change request targets. */
export type ChangeRequestTarget = 'scope' | 'plan' | 'baseline' | 'authority'

/** A request to change scope, plan, baseline, or authority — returned instead of silently widening the run. */
export interface ChangeRequest {
  /** What the requested change targets. */
  target: ChangeRequestTarget
  /** Why the change is needed. */
  reason: string
  /** The impact accepting the change would have. */
  impact: string
}

/**
 * The only transition a specialist may recommend: back to Conductor. No
 * specialist names the next specialist; Conductor alone routes onward.
 */
export interface RecommendedTransition {
  /** Fixed target — always Conductor. */
  target: 'conductor'
  /** What Conductor should evaluate before routing. */
  rationale: string
}

/** A specialist's confidence in its own result. */
export type Confidence = 'low' | 'medium' | 'high'

/**
 * The structured result a specialist returns, in the wire vocabulary the
 * `conductor-specialist` skill specifies. Fields are snake_case to match the
 * model-written YAML. A missing or malformed envelope is a `blocked` result,
 * never a silent pass.
 */
export interface SpecialistEnvelope {
  /** The run id this result belongs to. */
  run_id: string
  /** The dispatched role/stage name. */
  stage: string
  /** Source or execution baseline the specialist actually assessed. */
  baseline_ref: string
  /** Source baseline established by a ready Detective when intake did not supply one. */
  source_baseline?: string
  /** Delivery readiness — not a gate decision. */
  status: SpecialistStatus
  /** Concise result. */
  summary: string
  /** Cited evidence. */
  evidence: EvidenceItem[]
  /** Findings tied to evidence. */
  findings: Finding[]
  /** Assumptions the specialist made. */
  assumptions: string[]
  /** Blockers that stopped the work. */
  blockers: string[]
  /** Artifacts produced or located. */
  artifacts: string[]
  /** Requests to change scope, plan, baseline, or authority. */
  change_requests: ChangeRequest[]
  /** Candidate immutable execution baseline; required for a ready Gate C result. */
  execution_baseline?: ExecutionBaseline
  /** The only allowed transition: back to Conductor. */
  recommended_transition: RecommendedTransition
  /** The specialist's confidence in its result. */
  confidence: Confidence
}

/** The Arbiter's release decision. */
export type ArbiterDecision = 'go' | 'no-go'

/**
 * The Arbiter's structured decision, in the wire vocabulary the
 * `conductor-closeout` skill specifies. Conductor records it without rewriting.
 * A `go` moves the run to closeout; it never grants commit, push, merge, or
 * deploy authority by itself.
 */
export interface DecisionRecord {
  /** The run id this decision belongs to. */
  run_id: string
  /** GO or NO-GO. */
  decision: ArbiterDecision
  /** The evidence and reasoning behind the decision. */
  basis: string[]
  /** The artifacts reviewed to reach the decision. */
  evidence_reviewed: string[]
  /** Conditions the decision attaches. */
  conditions: string[]
  /** Risks that remain open after the decision. */
  open_risks: string[]
  /** Follow-up work the decision requires. */
  required_follow_up: string[]
}

/** An action named in an explicit closeout authorization. `record-only` performs no external action. */
export type ConductorCloseoutAction = ConductorAction | 'record-only'

/** Evidence-backed closeout input supplied by the mandate owner after an Arbiter GO. */
export interface CloseoutAuthorization {
  /** Must exactly match the run's mandate owner. */
  authorizedBy: string
  /** Action whose completed outcome is being recorded; the runtime never performs it. */
  action: ConductorCloseoutAction
  /** Concrete evidence that the named action completed, or that record-only closeout is appropriate. */
  outcomeEvidence: string[]
  /** Concrete actions already performed outside Conductor and now being recorded. */
  actionsTaken: string[]
  /** Remaining facts that were not verified. */
  unverifiedItems: string[]
  /** Risks that remain open after closeout. */
  openRisks: string[]
  /** Owned follow-up and the condition that makes it due. */
  followUp: { owner: string; dueCondition: string }[]
  /** Evidence links grouped by lifecycle concern. */
  traceability: {
    mandate: string[]
    baseline: string[]
    changes: string[]
    verification: string[]
    decision: string[]
  }
}

/** Durable closeout record created only from an explicit {@link CloseoutAuthorization}. */
export interface CloseoutRecord {
  /** Run this closeout belongs to. */
  run_id: string
  /** Arbiter decision that opened closeout. */
  arbiter_decision: 'go'
  /** Mandate owner who explicitly authorized the recorded action. */
  authorized_by: string
  /** Authorized action recorded by closeout; no action is executed by Conductor. */
  authorized_action: ConductorCloseoutAction
  /** Concrete actions already performed outside Conductor. */
  actions_taken: string[]
  /** Evidence of the action's outcome. */
  outcome_evidence: string[]
  /** Facts left unverified at closeout. */
  unverified_items: string[]
  /** Risks left open at closeout. */
  open_risks: string[]
  /** Owned follow-up with an explicit triggering condition. */
  follow_up: { owner: string; due_condition: string }[]
  /** Evidence links grouped by lifecycle concern. */
  traceability: {
    mandate: string[]
    baseline: string[]
    changes: string[]
    verification: string[]
    decision: string[]
  }
  /** Terminal run status. */
  status: 'closed'
}
