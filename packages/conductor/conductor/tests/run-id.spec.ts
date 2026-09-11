import { describe, expect, it } from 'vitest'
import { isValidRunId, mintRunId } from '../src/index.ts'

describe('dsh-conductor run-id', () => {
  it('mints a CON-YYYY-NNNN id from the year and sequence', () => {
    expect(mintRunId(new Date('2026-09-11'), 7)).toBe('CON-2026-0007')
    expect(mintRunId(new Date('2026-01-01'), 1234)).toBe('CON-2026-1234')
  })

  it('pads the sequence to four digits', () => {
    expect(mintRunId(new Date('2026-01-01'), 42)).toBe('CON-2026-0042')
  })

  it('accepts only well-formed ids', () => {
    expect(isValidRunId('CON-2026-0001')).toBe(true)
    expect(isValidRunId('CON-2026-1')).toBe(false)
    expect(isValidRunId('con-2026-0001')).toBe(false)
    expect(isValidRunId('X-2026-0001')).toBe(false)
    expect(isValidRunId('CON-2026-00001')).toBe(false)
    expect(isValidRunId('')).toBe(false)
  })
})
