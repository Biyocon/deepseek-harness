import { describe, expect, it } from 'vitest'
import { ralphDirective } from '../src/ralph.ts'

describe('dsh-tool-conductor ralph directive', () => {
  it('disables Ralph for a non-positive round budget', () => {
    expect(ralphDirective(0, 'body')).toBeUndefined()
    expect(ralphDirective(-1, 'body')).toBeUndefined()
  })

  it('injects the Ralph rules, the round budget, and the no-gate-pass contract', () => {
    const directive = ralphDirective(3, 'round protocol')
    expect(directive).toContain('Ralph round budget: 3')
    expect(directive).toContain('never passes Gate D or E')
    expect(directive).toContain('round protocol')
    expect(directive).toContain('final ImplementationReport')
  })

  it('falls back to a placeholder when the skill body is unavailable', () => {
    expect(ralphDirective(3, undefined)).toContain('(ralph skill body unavailable)')
  })
})
