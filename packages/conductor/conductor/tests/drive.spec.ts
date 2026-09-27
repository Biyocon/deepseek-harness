import { describe, expect, it } from 'vitest'
import { ConductorRunId, drive } from '../src/index.ts'
import type {
  ConductorDispatcher,
  ConductorRun,
  ConductorStage,
  DecisionRecord,
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

function makeEnvelope(stage: ConductorStage, overrides: Partial<SpecialistEnvelope> = {}): SpecialistEnvelope {
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
    ...overrides,
  }
}

function makeDecision(decision: 'go' | 'no-go' = 'go'): DecisionRecord {
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

describe('dsh-conductor drive', () => {
  it('drives through every gate to a GO decision and closeout', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) { return makeEnvelope(stage) },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('decision')
    if (outcome.kind !== 'decision') throw new Error('expected decision')
    expect(outcome.decision.decision).toBe('go')
    expect(outcome.run.currentStage).toBe('closeout')
    expect(outcome.run.status).toBe('awaiting_authorization')
    expect(outcome.run.sourceBaseline).toBe('HEAD')
    expect(outcome.run.decision).toEqual(outcome.decision)
    expect(outcome.run.history.map(record => record.gate)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(outcome.run.specialistReports.map(report => report.stage)).toEqual([
      'detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'integrator',
    ])
  })

  it('does not turn a ready self-report into a gate pass without evidence', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) { return makeEnvelope(stage, { evidence: [] }) },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun(), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.blocker).toMatch(/fresh evidence/)
      expect(outcome.run.history.at(-1)?.decision).toBe('escalate')
      expect(outcome.run.specialistReports).toHaveLength(1)
    }
  })

  it('rejects a ready Detective that did not establish the missing source baseline', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        const envelope = makeEnvelope(stage)
        if (stage !== 'detective') return envelope
        const { source_baseline: _omitted, ...withoutSourceBaseline } = envelope
        return withoutSourceBaseline
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun(), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') expect(outcome.blocker).toMatch(/establish source_baseline/)
  })

  it('rejects a Gate C baseline that widens the owner-authorized paths', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        if (stage !== 'devils-advocate') return makeEnvelope(stage)
        return makeEnvelope(stage, {
          execution_baseline: {
            scopeVersion: 'scope-1', planVersion: 'plan-1', acceptanceVersion: 'accept-1',
            allowedPaths: ['.'], excludedPaths: [], rollbackReference: 'HEAD',
          },
        })
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun(), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') expect(outcome.blocker).toMatch(/owner-authorized run paths/)
  })

  it('routes an auditor rework back to headsman and continues', async () => {
    let auditorCalls = 0
    const dispatched: ConductorStage[] = []
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        dispatched.push(stage)
        if (stage === 'auditor') {
          auditorCalls += 1
          if (auditorCalls === 1) return makeEnvelope(stage, { status: 'rework' })
        }
        return makeEnvelope(stage)
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('decision')
    expect(dispatched).toEqual([
      'detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'headsman', 'auditor', 'integrator',
    ])
    const run = outcome.kind === 'decision' ? outcome.run : undefined
    expect(run?.history.filter(record => record.decision === 'rework')).toHaveLength(1)
  })

  it('routes a scope rework from the auditor to detective', async () => {
    const dispatched: ConductorStage[] = []
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        dispatched.push(stage)
        if (stage === 'auditor') {
          return makeEnvelope(stage, {
            status: 'rework',
            change_requests: [{ target: 'scope', reason: 'scope was misunderstood', impact: 're-scope' }],
          })
        }
        return makeEnvelope(stage)
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    const auditor = dispatched.indexOf('auditor')
    expect(dispatched[auditor + 1]).toBe('detective')
  })

  it('parks a blocked specialist result for the owner', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        if (stage === 'detective') return makeEnvelope(stage, { status: 'blocked', blockers: ['missing mandate'] })
        return makeEnvelope(stage)
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.run.status).toBe('escalated')
      expect(outcome.run.history.at(-1)?.decision).toBe('escalate')
    }
  })

  it('rejects a malformed envelope as a blocker, not a pass', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist() {
        return {
          run_id: 'wrong-id', stage: 'detective', status: 'ready', summary: '',
          baseline_ref: 'HEAD',
          evidence: [], findings: [], assumptions: [], blockers: [], artifacts: [], change_requests: [],
          recommended_transition: { target: 'strategist', rationale: '' }, confidence: 'high',
        } as unknown as SpecialistEnvelope
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.blocker).toMatch(/run_id|stage|summary/)
    }
  })

  it('escalates an authority change request from a specialist', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        if (stage === 'headsman') {
          return makeEnvelope(stage, {
            status: 'rework',
            change_requests: [{ target: 'authority', reason: 'needs write access', impact: 'blocked' }],
          })
        }
        return makeEnvelope(stage)
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') expect(outcome.blocker).toContain('authority change')
  })

  it('escalates an arbiter NO-GO to the owner', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) { return makeEnvelope(stage) },
      async dispatchArbiter() { return makeDecision('no-go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.blocker).toContain('NO-GO')
      expect(outcome.run.status).toBe('escalated')
    }
  })

  it('rejects an Arbiter GO whose basis is blank', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) { return makeEnvelope(stage) },
      async dispatchArbiter() { return { ...makeDecision('go'), basis: [''] } },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.blocker).toMatch(/basis.*non-empty normalized strings/)
      expect(outcome.run.history.at(-1)?.decision).toBe('escalate')
    }
  })

  it('rejects an Arbiter GO whose reviewed evidence is blank', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) { return makeEnvelope(stage) },
      async dispatchArbiter() { return { ...makeDecision('go'), evidence_reviewed: [''] } },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective' }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.blocker).toMatch(/evidence_reviewed.*non-empty normalized strings/)
      expect(outcome.run.history.at(-1)?.decision).toBe('escalate')
    }
  })

  it('escalates once the rework budget is exhausted', async () => {
    const dispatcher: ConductorDispatcher = {
      async dispatchSpecialist(stage) {
        if (stage === 'auditor') return makeEnvelope(stage, { status: 'rework' })
        return makeEnvelope(stage)
      },
      async dispatchArbiter() { return makeDecision('go') },
    }
    const outcome = await drive(makeRun({ currentStage: 'detective', budget: { maxReworkCycles: 1, maxRalphRounds: 0 } }), dispatcher)
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.run.status).toBe('escalated')
      expect(outcome.run.history.filter(record => record.decision === 'rework')).toHaveLength(1)
      expect(outcome.run.history.at(-1)?.decision).toBe('escalate')
    }
  })
})
