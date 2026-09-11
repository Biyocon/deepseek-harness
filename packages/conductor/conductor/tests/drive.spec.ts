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
    authority: { owner: 'user', permittedActions: ['read'] },
    constraints: [],
    acceptanceCriteria: [],
    budget: { maxReworkCycles: 3, maxRalphRounds: 0 },
    baseline: null,
    currentStage: 'detective',
    history: [],
    status: 'running',
    ...overrides,
  }
}

function makeEnvelope(stage: ConductorStage, overrides: Partial<SpecialistEnvelope> = {}): SpecialistEnvelope {
  return {
    run_id: 'CON-2026-0001',
    stage,
    status: 'ready',
    summary: 'done',
    evidence: [],
    findings: [],
    assumptions: [],
    blockers: [],
    artifacts: [],
    change_requests: [],
    recommended_transition: { target: 'conductor', rationale: 'evaluate' },
    confidence: 'high',
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
    expect(outcome.run.history.map(record => record.gate)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
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
