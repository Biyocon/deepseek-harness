import { describe, expect, it } from 'vitest'
import {
  ConductorRunId,
  InMemoryConductorRunStore,
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

function gateRecord(partial: Pick<GateRecord, 'gate' | 'stage' | 'decision'> & Partial<GateRecord>): GateRecord {
  return { basis: [], evidenceReviewed: [], stateUpdate: '', ...partial }
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

  it('rejects resume of a closed or aborted run', () => {
    expect(() => { validateResumable(makeRun({ status: 'closed' })) }).toThrow(/closed/)
    expect(() => { validateResumable(makeRun({ status: 'aborted' })) }).toThrow(/aborted/)
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
