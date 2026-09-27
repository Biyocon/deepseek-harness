import { describe, expect, it } from 'vitest'
import {
  ConductorRunId,
  closeRun,
  gateOfStage,
  nextStageAfterPass,
  recordGate,
  reworkCycles,
  stageOfGate,
} from '../src/index.ts'
import type { ConductorRun, ConductorStage, GateId, GateRecord, GateVerdict } from '../src/index.ts'

function makeRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
  return {
    runId: ConductorRunId('CON-2026-0001'),
    objective: 'ship the feature',
    scope: [],
    inputArtifacts: [],
    allowedPaths: [],
    excludedPaths: [],
    sourceBaseline: null,
    authority: { owner: 'user', permittedActions: ['read'] },
    constraints: [],
    acceptanceCriteria: [],
    budget: { maxReworkCycles: 3, maxRalphRounds: 0 },
    baseline: null,
    currentStage: 'detective',
    history: [],
    specialistReports: [],
    status: 'running',
    ...overrides,
  }
}

function gateRecord(partial: Pick<GateRecord, 'gate' | 'stage' | 'decision'> & Partial<GateRecord>): GateRecord {
  return { basis: [], evidenceReviewed: [], stateUpdate: '', ...partial }
}

const PASS: GateVerdict = {
  decision: 'pass',
  basis: ['evidence'],
  evidenceReviewed: ['artifact'],
  stateUpdate: 'advance',
}

describe('dsh-conductor gate engine', () => {
  it('maps each gated stage to its gate letter and back', () => {
    const pairs: Array<[ConductorStage, GateId]> = [
      ['detective', 'A'],
      ['strategist', 'B'],
      ['devils-advocate', 'C'],
      ['headsman', 'D'],
      ['auditor', 'E'],
      ['integrator', 'F'],
      ['arbiter', 'G'],
    ]
    for (const [stage, gate] of pairs) {
      expect(gateOfStage(stage)).toBe(gate)
      expect(stageOfGate(gate)).toBe(stage)
    }
    expect(gateOfStage('intake')).toBeUndefined()
    expect(gateOfStage('ralph')).toBeUndefined()
    expect(gateOfStage('closeout')).toBeUndefined()
  })

  it('advances pass decisions along the linear pass path', () => {
    const path: Array<[ConductorStage, ConductorStage]> = [
      ['detective', 'strategist'],
      ['strategist', 'devils-advocate'],
      ['devils-advocate', 'headsman'],
      ['headsman', 'auditor'],
      ['auditor', 'integrator'],
      ['integrator', 'arbiter'],
      ['arbiter', 'closeout'],
    ]
    for (const [from, to] of path) {
      expect(nextStageAfterPass(from)).toBe(to)
    }
    expect(nextStageAfterPass('closeout')).toBeUndefined()
    expect(nextStageAfterPass('intake')).toBeUndefined()
  })

  it('records a pass with the derived gate letter and advances the stage', () => {
    const next = recordGate(makeRun({ currentStage: 'detective' }), PASS)
    expect(next.history).toHaveLength(1)
    expect(next.history[0]).toMatchObject({ gate: 'A', stage: 'detective', decision: 'pass', nextStage: 'strategist' })
    expect(next.currentStage).toBe('strategist')
    expect(next.status).toBe('running')
  })

  it('records an Arbiter pass by moving the run to closeout', () => {
    const next = recordGate(makeRun({ currentStage: 'arbiter' }), PASS)
    expect(next.currentStage).toBe('closeout')
    expect(next.history[0]).toMatchObject({ gate: 'G', decision: 'pass', nextStage: 'closeout' })
    expect(next.status).toBe('awaiting_authorization')
  })

  it('records a rework within budget, routing to the target and counting the cycle', () => {
    const next = recordGate(makeRun({ currentStage: 'auditor' }), {
      decision: 'rework',
      defectClass: 'implementation',
      nextStage: 'headsman',
      basis: ['acceptance fails'],
      evidenceReviewed: ['verification report'],
      stateUpdate: 'fix implementation',
    })
    expect(reworkCycles(next)).toBe(1)
    expect(next.history[0]).toMatchObject({ gate: 'E', decision: 'rework', defectClass: 'implementation', nextStage: 'headsman' })
    expect(next.currentStage).toBe('headsman')
    expect(next.status).toBe('rework')
  })

  it('escalates a rework once the rework budget is exhausted', () => {
    const run = makeRun({
      currentStage: 'auditor',
      budget: { maxReworkCycles: 2, maxRalphRounds: 0 },
      history: [
        gateRecord({ gate: 'D', stage: 'headsman', decision: 'rework', defectClass: 'implementation', nextStage: 'headsman' }),
        gateRecord({ gate: 'E', stage: 'auditor', decision: 'rework', defectClass: 'implementation', nextStage: 'headsman' }),
      ],
    })
    const next = recordGate(run, {
      decision: 'rework',
      defectClass: 'implementation',
      nextStage: 'headsman',
      basis: ['still failing'],
      evidenceReviewed: [],
      stateUpdate: 'escalate',
    })
    expect(next.history.at(-1)).toMatchObject({ gate: 'E', decision: 'escalate', nextStage: 'headsman' })
    expect(next.status).toBe('escalated')
    expect(reworkCycles(next)).toBe(2)
  })

  it('records an abort as terminal and stops at the current stage', () => {
    const next = recordGate(makeRun({ currentStage: 'headsman' }), {
      decision: 'abort',
      basis: ['stop condition met'],
      evidenceReviewed: [],
      stateUpdate: 'stop',
    })
    expect(next.status).toBe('aborted')
    expect(next.currentStage).toBe('headsman')
    expect(next.history[0]).toMatchObject({ gate: 'D', decision: 'abort' })
    expect(next.history[0]?.nextStage).toBeUndefined()
  })

  it('records an explicit escalate and parks the run', () => {
    const next = recordGate(makeRun({ currentStage: 'strategist' }), {
      decision: 'escalate',
      basis: ['needs owner decision'],
      evidenceReviewed: [],
      stateUpdate: 'ask owner',
    })
    expect(next.status).toBe('escalated')
    expect(next.history[0]).toMatchObject({ gate: 'B', decision: 'escalate' })
  })

  it('rejects a gate decision on a non-gated stage', () => {
    for (const stage of ['intake', 'ralph', 'closeout'] as const) {
      expect(() => recordGate(makeRun({ currentStage: stage }), PASS)).toThrow(/owns no gate/)
    }
  })

  it('rejects a gate decision on a terminal run', () => {
    expect(() => recordGate(makeRun({ status: 'closed' }), PASS)).toThrow(/closed/)
    expect(() => recordGate(makeRun({ status: 'aborted' }), PASS)).toThrow(/aborted/)
  })

  it('requires a defect class and a rework target for a rework', () => {
    const run = makeRun({ currentStage: 'auditor' })
    expect(() => recordGate(run, {
      decision: 'rework', basis: [], evidenceReviewed: [], nextStage: 'headsman', stateUpdate: '',
    })).toThrow(/defect class/)
    expect(() => recordGate(run, {
      decision: 'rework', basis: [], evidenceReviewed: [], defectClass: 'implementation', stateUpdate: '',
    })).toThrow(/target stage/)
  })

  it('does not mutate the input run', () => {
    const run = makeRun({ currentStage: 'detective' })
    recordGate(run, PASS)
    expect(run.history).toHaveLength(0)
    expect(run.currentStage).toBe('detective')
    expect(run.status).toBe('running')
  })

  it('requires explicit owner authority and records a traceable closeout without executing it', () => {
    const run = makeRun({
      authority: { owner: 'user', permittedActions: ['read', 'deploy'] },
      currentStage: 'closeout',
      status: 'awaiting_authorization',
      decision: {
        run_id: 'CON-2026-0001', decision: 'go', basis: ['verified'], evidence_reviewed: ['report'],
        conditions: [], open_risks: [], required_follow_up: [],
      },
    })
    const authorization = {
      authorizedBy: 'user', action: 'deploy' as const, actionsTaken: ['deployed release 12'],
      outcomeEvidence: ['deployment health check passed'], unverifiedItems: [], openRisks: [],
      followUp: [{ owner: 'release-owner', dueCondition: 'next release window' }],
      traceability: {
        mandate: ['request'], baseline: ['abc120'], changes: ['abc123'],
        verification: ['CI 42'], decision: ['Gate G'],
      },
    }
    const closed = closeRun(run, authorization)
    expect(closed.status).toBe('closed')
    expect(closed.closeout).toMatchObject({
      arbiter_decision: 'go', authorized_by: 'user', authorized_action: 'deploy',
      actions_taken: ['deployed release 12'], follow_up: [{ owner: 'release-owner', due_condition: 'next release window' }],
    })
    expect(run.status).toBe('awaiting_authorization')
  })

  it('rejects closeout from the wrong owner or for an unauthorized action', () => {
    const run = makeRun({
      currentStage: 'closeout', status: 'awaiting_authorization',
      decision: {
        run_id: 'CON-2026-0001', decision: 'go', basis: [], evidence_reviewed: [],
        conditions: [], open_risks: [], required_follow_up: [],
      },
    })
    const authorization = {
      authorizedBy: 'impostor', action: 'merge' as const, actionsTaken: [], outcomeEvidence: ['evidence'],
      unverifiedItems: [], openRisks: [], followUp: [],
      traceability: { mandate: [], baseline: [], changes: [], verification: [], decision: [] },
    }
    expect(() => closeRun(run, authorization)).toThrow(/mandate owner/)
    expect(() => closeRun(run, { ...authorization, authorizedBy: 'user' })).toThrow(/outside the run authority/)
  })
})
