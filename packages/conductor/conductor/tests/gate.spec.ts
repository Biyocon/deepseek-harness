import { describe, expect, it } from 'vitest'
import { ConductorRunId, drive, reworkTarget, routeGate } from '../src/index.ts'
import type {
  ConductorDispatcher,
  ConductorRun,
  ConductorStage,
  DecisionRecord,
  DefectClass,
  SpecialistEnvelope,
} from '../src/index.ts'

function makeRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
  return {
    runId: ConductorRunId('CON-2026-0001'),
    objective: 'ship the feature',
    scope: [],
    inputArtifacts: [],
    allowedPaths: ['packages/conductor'],
    excludedPaths: [],
    sourceBaseline: null,
    authority: { owner: 'user', permittedActions: ['read'] },
    constraints: [],
    acceptanceCriteria: ['feature works'],
    budget: { maxReworkCycles: 3, maxRalphRounds: 0 },
    baseline: null,
    currentStage: 'detective',
    history: [],
    specialistReports: [],
    status: 'running',
    ...overrides,
  }
}

function makeEnvelope(stage: ConductorStage): SpecialistEnvelope {
  return {
    run_id: 'CON-2026-0001',
    stage,
    baseline_ref: 'HEAD',
    ...stage === 'detective' ? { source_baseline: 'HEAD' } : {},
    status: 'ready',
    summary: 'done',
    evidence: [{ kind: 'test', reference: `${stage}-check`, outcome: 'passed' }],
    findings: [],
    assumptions: [],
    blockers: [],
    artifacts: [],
    change_requests: [],
    recommended_transition: { target: 'conductor', rationale: 'evaluate' },
    confidence: 'high',
    ...stage === 'devils-advocate' ? {
      execution_baseline: {
        scopeVersion: 'scope-1', planVersion: 'plan-1', acceptanceVersion: 'accept-1',
        allowedPaths: ['packages/conductor'], excludedPaths: [], rollbackReference: 'HEAD',
      },
    } : {},
  }
}

function makeDecision(decision: 'go' | 'no-go'): DecisionRecord {
  return {
    run_id: 'CON-2026-0001',
    decision,
    basis: ['evidence meets criteria'],
    evidence_reviewed: ['delivery package'],
    conditions: [],
    open_risks: [],
    required_follow_up: [],
  }
}

describe('dsh-conductor gate invariants', () => {
  it('the Auditor never routes a rework back to itself', () => {
    const classes: DefectClass[] = ['scope', 'plan', 'implementation', 'delivery']
    for (const defectClass of classes) {
      expect(reworkTarget(defectClass)).not.toBe('auditor')
      expect(routeGate('E', 'rework', defectClass).nextStage).not.toBe('auditor')
    }
  })

  it('the Arbiter never reworks a specialist stage on its own authority', () => {
    // A rework at the Arbiter gate escalates to the owner; it never names a specialist.
    expect(routeGate('G', 'rework', 'delivery')).toEqual({ decision: 'escalate' })
  })

  it('a GO reaches closeout but performs and records no release action', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) { return makeEnvelope(stage) },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('decision')
    if (outcome.kind !== 'decision') throw new Error('expected decision')
    expect(outcome.run.currentStage).toBe('closeout')
    // Closeout records the decision, not a release: the run stays awaiting authorization until
    // the authorized release action and its verification are recorded.
    expect(outcome.run.status).toBe('awaiting_authorization')
    expect(outcome.run.history.at(-1)).toMatchObject({ gate: 'G', decision: 'pass' })
  })
})
