import { describe, expect, it } from 'vitest'
import { decisionForStatus, reworkTarget, routeGate } from '../src/index.ts'
import type { ConductorStage, DefectClass } from '../src/index.ts'

describe('dsh-conductor routing', () => {
  it('maps each specialist status to its gate decision', () => {
    expect(decisionForStatus('ready')).toBe('pass')
    expect(decisionForStatus('rework')).toBe('rework')
    expect(decisionForStatus('blocked')).toBe('escalate')
    expect(decisionForStatus('failed')).toBe('escalate')
  })

  it('maps each defect class to its owning stage', () => {
    const pairs: Array<[DefectClass, ConductorStage]> = [
      ['scope', 'detective'],
      ['plan', 'strategist'],
      ['implementation', 'headsman'],
      ['delivery', 'integrator'],
    ]
    for (const [defectClass, stage] of pairs) {
      expect(reworkTarget(defectClass)).toBe(stage)
    }
  })

  it('routes a ready result along the linear pass path', () => {
    expect(routeGate('A', 'ready')).toEqual({ decision: 'pass', nextStage: 'strategist' })
    expect(routeGate('D', 'ready')).toEqual({ decision: 'pass', nextStage: 'auditor' })
    expect(routeGate('G', 'ready')).toEqual({ decision: 'pass', nextStage: 'closeout' })
  })

  it('routes a rework to the stage owning the defect class', () => {
    expect(routeGate('E', 'rework', 'implementation')).toEqual({ decision: 'rework', defectClass: 'implementation', nextStage: 'headsman' })
    expect(routeGate('E', 'rework', 'plan')).toEqual({ decision: 'rework', defectClass: 'plan', nextStage: 'strategist' })
    expect(routeGate('E', 'rework', 'scope')).toEqual({ decision: 'rework', defectClass: 'scope', nextStage: 'detective' })
    expect(routeGate('F', 'rework', 'delivery')).toEqual({ decision: 'rework', defectClass: 'delivery', nextStage: 'integrator' })
  })

  it('routes a blocked or failed result to escalate with no successor stage', () => {
    expect(routeGate('D', 'blocked')).toEqual({ decision: 'escalate' })
    expect(routeGate('D', 'failed')).toEqual({ decision: 'escalate' })
  })

  it('escalates a rework at the Arbiter gate instead of naming a specialist', () => {
    expect(routeGate('G', 'rework', 'delivery')).toEqual({ decision: 'escalate' })
  })

  it('requires a defect class to route a rework', () => {
    expect(() => routeGate('E', 'rework')).toThrow(/defect class/)
  })
})
