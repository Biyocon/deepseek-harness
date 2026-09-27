import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ConductorRunId,
  InMemoryConductorRunStore,
  SessionConductorRunStore,
  parseRun,
  recordGate,
  resumeRun,
  serializeRun,
  validateResumable,
} from '../src/index.ts'
import type { ConductorRun, GateRecord } from '../src/index.ts'

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

function makeClosedRun(): ConductorRun {
  return makeRun({
    acceptanceCriteria: ['feature works'],
    authority: { owner: 'user', permittedActions: ['read', 'deploy'] },
    currentStage: 'closeout',
    history: [gateRecord({
      gate: 'G', stage: 'arbiter', decision: 'pass', nextStage: 'closeout',
      basis: ['verified'], evidenceReviewed: ['report'], stateUpdate: 'move to closeout',
    })],
    status: 'closed',
    decision: {
      run_id: 'CON-2026-0001', decision: 'go', basis: ['verified'], evidence_reviewed: ['report'],
      conditions: [], open_risks: [], required_follow_up: [],
    },
    closeout: {
      run_id: 'CON-2026-0001', arbiter_decision: 'go', authorized_by: 'user', authorized_action: 'deploy',
      actions_taken: ['recorded deployment'], outcome_evidence: ['health check'], unverified_items: [], open_risks: [],
      follow_up: [],
      traceability: {
        mandate: ['request'], baseline: ['HEAD'], changes: ['release'], verification: ['health check'], decision: ['Gate G'],
      },
      status: 'closed',
    },
  })
}

describe('dsh-conductor persistence', () => {
  it('round-trips a run through the JSON wire format unchanged', () => {
    const run = makeRun({
      currentStage: 'auditor',
      history: [gateRecord({ gate: 'E', stage: 'auditor', decision: 'rework', defectClass: 'implementation', nextStage: 'headsman' })],
      status: 'rework',
    })
    expect(parseRun(serializeRun(run))).toEqual(run)
  })

  it('rejects invalid JSON and non-object records', () => {
    expect(() => parseRun('not json')).toThrow(/not valid JSON/)
    expect(() => parseRun('42')).toThrow(/JSON object/)
    expect(() => parseRun('null')).toThrow(/JSON object/)
    expect(() => parseRun('[]')).toThrow(/JSON object/)
  })

  it('rejects records with invalid discriminant tags', () => {
    expect(() => parseRun(JSON.stringify({ ...makeRun(), status: 'bogus' }))).toThrow(/invalid status/)
    expect(() => parseRun(JSON.stringify({ ...makeRun(), currentStage: 'bogus' }))).toThrow(/invalid currentStage/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      history: [{ gate: 'A', stage: 'detective', decision: 'bogus', basis: [], evidenceReviewed: [], stateUpdate: '' }],
    }))).toThrow(/invalid decision/)
  })

  it('rejects malformed nested durable state before it reaches resume logic', () => {
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      authority: { owner: 'user', permittedActions: ['delete'] },
    }))).toThrow(/invalid action/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      baseline: {
        scopeVersion: 'scope-v1',
        planVersion: 'plan-v1',
        acceptanceVersion: 'acceptance-v1',
        allowedPaths: [42],
        excludedPaths: [],
        rollbackReference: 'HEAD',
      },
    }))).toThrow(/baseline.allowedPaths/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      allowedPaths: ['packages/conductor'],
      baseline: {
        scopeVersion: 'scope-v1',
        planVersion: 'plan-v1',
        acceptanceVersion: 'acceptance-v1',
        allowedPaths: ['.'],
        excludedPaths: [],
        rollbackReference: 'HEAD',
      },
    }))).toThrow(/baseline paths must match/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      excludedPaths: ['secrets'],
      baseline: {
        scopeVersion: 'scope-v1',
        planVersion: 'plan-v1',
        acceptanceVersion: 'acceptance-v1',
        allowedPaths: [],
        excludedPaths: [],
        rollbackReference: 'HEAD',
      },
    }))).toThrow(/baseline paths must match/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      history: [gateRecord({ gate: 'A', stage: 'auditor', decision: 'pass', nextStage: 'strategist' })],
    }))).toThrow(/gate A cannot belong to stage auditor/)
    const { specialistReports: _omitted, ...withoutReports } = makeRun()
    expect(() => parseRun(JSON.stringify(withoutReports))).toThrow(/specialistReports must be an array/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(), acceptanceCriteria: [''],
    }))).toThrow(/acceptanceCriteria must contain only non-empty normalized strings/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(), acceptanceCriteria: ['same', 'same'],
    }))).toThrow(/acceptanceCriteria must not contain duplicates/)
  })

  it('rejects semantically impossible gate records and lifecycle status', () => {
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      history: [gateRecord({ gate: 'A', stage: 'detective', decision: 'pass', nextStage: 'headsman' })],
    }))).toThrow(/pass has invalid nextStage/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun({ status: 'rework', currentStage: 'headsman' }),
      history: [gateRecord({ gate: 'A', stage: 'detective', decision: 'rework', nextStage: 'headsman' })],
    }))).toThrow(/rework has invalid defectClass/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun(),
      history: [gateRecord({ gate: 'A', stage: 'detective', decision: 'abort' })],
    }))).toThrow(/status running does not match/)
  })

  it('rejects lifecycle records whose decision or closeout cannot support the status', () => {
    expect(() => parseRun(JSON.stringify({
      ...makeRun({ status: 'awaiting_authorization', currentStage: 'closeout' }),
      decision: {
        run_id: 'CON-2026-0002',
        decision: 'go',
        basis: ['verified'],
        evidence_reviewed: ['report'],
        conditions: [],
        open_risks: [],
        required_follow_up: [],
      },
    }))).toThrow(/decision.run_id must match/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun({ status: 'closed', currentStage: 'closeout' }),
      decision: {
        run_id: 'CON-2026-0001',
        decision: 'go',
        basis: ['verified'],
        evidence_reviewed: ['report'],
        conditions: [],
        open_risks: [],
        required_follow_up: [],
      },
    }))).toThrow(/requires closeout/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun({ status: 'awaiting_authorization', currentStage: 'closeout' }),
      decision: {
        run_id: 'CON-2026-0001', decision: 'go', basis: [''], evidence_reviewed: ['report'],
        conditions: [], open_risks: [], required_follow_up: [],
      },
    }))).toThrow(/decision.basis must contain only non-empty normalized strings/)
    expect(() => parseRun(JSON.stringify({
      ...makeRun({ status: 'awaiting_authorization', currentStage: 'closeout' }),
      decision: {
        run_id: 'CON-2026-0001', decision: 'go', basis: ['verified'], evidence_reviewed: [],
        conditions: [], open_risks: [], required_follow_up: [],
      },
    }))).toThrow(/GO requires a non-empty basis and reviewed evidence/)
  })

  it('rejects tampered durable closeout authority and outcome evidence', () => {
    const valid = makeClosedRun()
    expect(parseRun(serializeRun(valid))).toEqual(valid)
    expect(() => parseRun(serializeRun({
      ...valid, closeout: { ...valid.closeout!, authorized_by: 'impostor' },
    }))).toThrow(/authorized_by must match authority.owner/)
    expect(() => parseRun(serializeRun({
      ...valid,
      authority: { owner: 'user', permittedActions: ['read'] },
    }))).toThrow(/authorized_action is outside the run authority/)
    expect(() => parseRun(serializeRun({
      ...valid, closeout: { ...valid.closeout!, outcome_evidence: [] },
    }))).toThrow(/outcome_evidence must not be empty/)
  })

  it('stores, loads, and deletes runs keyed by run id without aliasing', async () => {
    const store = new InMemoryConductorRunStore()
    const run = makeRun()
    await store.save(run)
    const loaded = await store.load(run.runId)
    expect(loaded).toEqual(run)
    expect(loaded).not.toBe(run)
    await store.delete(run.runId)
    expect(await store.load(run.runId)).toBeUndefined()
  })

  it('reconstructs the latest run from durable session checkpoints and flushes every mutation', async () => {
    const session = Session.create(SessionId('conductor-checkpoints'))
    let flushes = 0
    const store = new SessionConductorRunStore(session, () => {
      flushes += 1
      return Promise.resolve()
    })
    const initial = makeRun()
    await store.save(initial)
    const advanced = recordGate(initial, {
      decision: 'pass', basis: ['scope clear'], evidenceReviewed: ['report'], stateUpdate: 'advance',
    })
    await store.save(advanced)
    const reopened = new SessionConductorRunStore(session, () => Promise.resolve())
    expect(await reopened.load(initial.runId)).toEqual(advanced)
    expect(flushes).toBe(2)
    await store.delete(initial.runId)
    expect(await reopened.load(initial.runId)).toBeUndefined()
    expect(flushes).toBe(3)
  })

  it('rejects resume of a closed, aborted, or escalated run', () => {
    expect(() => { validateResumable(makeRun({ status: 'closed' })) }).toThrow(/closed/)
    expect(() => { validateResumable(makeRun({ status: 'aborted' })) }).toThrow(/aborted/)
    expect(() => { validateResumable(makeRun({ status: 'escalated' })) }).toThrow(/owner resolution/)
  })

  it('rejects a run with no gate history parked past the initial stage', () => {
    expect(() => { validateResumable(makeRun({ currentStage: 'auditor' })) }).toThrow(/no gate history/)
  })

  it('rejects a run whose stage does not match its last documented gate', () => {
    const run = makeRun({
      currentStage: 'auditor',
      history: [gateRecord({ gate: 'A', stage: 'detective', decision: 'pass', nextStage: 'strategist' })],
    })
    expect(() => { validateResumable(run) }).toThrow(/does not match last gate A/)
  })

  it('rejects a run whose documented history skips a stage', () => {
    const run = makeRun({
      currentStage: 'devils-advocate',
      history: [gateRecord({ gate: 'B', stage: 'strategist', decision: 'pass', nextStage: 'devils-advocate' })],
    })
    expect(() => { validateResumable(run) }).toThrow(/history jumps to gate B/)
  })

  it('resumes a run at exactly its last documented, valid state', async () => {
    const store = new InMemoryConductorRunStore()
    const advanced = recordGate(makeRun({ currentStage: 'detective' }), {
      decision: 'pass', basis: ['scope clear'], evidenceReviewed: ['report'], stateUpdate: 'advance',
    })
    await store.save(advanced)
    const resumed = await resumeRun(store, advanced.runId)
    expect(resumed.currentStage).toBe('strategist')
    expect(resumed.history).toHaveLength(1)
  })

  it('throws when resuming an unknown run id', async () => {
    const store = new InMemoryConductorRunStore()
    await expect(resumeRun(store, ConductorRunId('CON-9999-9999'))).rejects.toThrow(/not found/)
  })
})
