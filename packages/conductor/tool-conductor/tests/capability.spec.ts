import { describe, expect, it } from 'vitest'
import { READ_TOOLS, toolRestrictionForStage, WRITE_TOOLS } from '../src/capability.ts'

describe('dsh-tool-conductor capability policies', () => {
  it('keeps read-only stages to the read/search tools', () => {
    for (const stage of ['detective', 'strategist', 'devils-advocate', 'auditor', 'arbiter'] as const) {
      expect(toolRestrictionForStage(stage)).toEqual({ allow: [...READ_TOOLS] })
    }
  })

  it('imposes no name-level restriction on the Headsman', () => {
    expect(toolRestrictionForStage('headsman')).toBeUndefined()
  })

  it('gives the Integrator read and write tools but no shell', () => {
    expect(toolRestrictionForStage('integrator')).toEqual({ allow: [...READ_TOOLS, ...WRITE_TOOLS] })
  })

  it('rejects stages that own no specialist capability policy', () => {
    for (const stage of ['intake', 'ralph', 'closeout'] as const) {
      expect(() => toolRestrictionForStage(stage)).toThrow(/capability policy/)
    }
  })
})
