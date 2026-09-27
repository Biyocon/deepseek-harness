import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  IMPLEMENTATION_TOOLS,
  READ_TOOLS,
  toolGuardForStage,
  toolRestrictionForStage,
  WRITE_TOOLS,
} from '../src/capability.ts'

describe('dsh-tool-conductor capability policies', () => {
  it('keeps read-only stages to the read/search tools', () => {
    for (const stage of ['detective', 'strategist', 'devils-advocate', 'auditor', 'arbiter'] as const) {
      expect(toolRestrictionForStage(stage, ['read', 'write'])).toEqual({ allow: [...READ_TOOLS] })
    }
  })

  it('removes shell and release-capable tools from the Headsman', () => {
    expect(toolRestrictionForStage('headsman', ['read', 'write'])).toEqual({ allow: [...IMPLEMENTATION_TOOLS] })
  })

  it('denies Headsman writes outside allowed paths and every excluded path', () => {
    const guard = toolGuardForStage('headsman', {
      scopeVersion: 'scope-1', planVersion: 'plan-1', acceptanceVersion: 'accept-1',
      allowedPaths: ['packages/conductor'], excludedPaths: ['packages/conductor/private'], rollbackReference: 'HEAD',
    }, ['read', 'write'])
    const execution = (file_path: string) => ({
      name: 'write', arguments: { file_path }, agent: { session: { header: { cwd: process.cwd() } } },
    }) as unknown as ToolExecution
    expect(guard(execution('packages/conductor/conductor/README.md'))).toBeUndefined()
    expect(guard(execution('packages/core/session/README.md'))).toMatch(/outside allowed_paths/)
    expect(guard(execution('packages/conductor/private/secret.md'))).toMatch(/excluded/)
  })

  it('limits Integrator writes to docs and Agent Notes inside the baseline', () => {
    const guard = toolGuardForStage('integrator', {
      scopeVersion: 'scope-1', planVersion: 'plan-1', acceptanceVersion: 'accept-1',
      allowedPaths: ['.'], excludedPaths: [], rollbackReference: 'HEAD',
    }, ['read', 'write'])
    const execution = (file_path: string) => ({
      name: 'edit', arguments: { file_path }, agent: { session: { header: { cwd: process.cwd() } } },
    }) as unknown as ToolExecution
    expect(guard(execution('docs/architecture.md'))).toBeUndefined()
    expect(guard(execution('.agents/notes/implemented/feature/2026-09-11-conductor-runtime-layer.md'))).toBeUndefined()
    expect(guard(execution('packages/conductor/conductor/src/state.ts'))).toMatch(/outside docs\/notes/)
  })

  it('denies a write that escapes allowed paths through a symlink or junction', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-conductor-policy-'))
    try {
      const allowed = join(root, 'allowed')
      const outside = join(root, 'outside')
      mkdirSync(allowed)
      mkdirSync(outside)
      symlinkSync(outside, join(allowed, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
      const guard = toolGuardForStage('headsman', {
        scopeVersion: 'scope-1', planVersion: 'plan-1', acceptanceVersion: 'accept-1',
        allowedPaths: [allowed], excludedPaths: [], rollbackReference: 'HEAD',
      }, ['read', 'write'])
      const execution = {
        name: 'write',
        arguments: { file_path: join(allowed, 'alias', 'escape.md') },
        agent: { session: { header: { cwd: root } } },
      } as unknown as ToolExecution
      expect(guard(execution)).toMatch(/outside allowed_paths/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('gives the Integrator read and write tools but no shell', () => {
    expect(toolRestrictionForStage('integrator', ['read', 'write'])).toEqual({ allow: [...READ_TOOLS, ...WRITE_TOOLS] })
  })

  it('intersects write-capable stages with the mandate actions', () => {
    expect(toolRestrictionForStage('headsman', ['read'])).toEqual({ allow: [...READ_TOOLS] })
    const guard = toolGuardForStage('headsman', {
      scopeVersion: 'scope-1', planVersion: 'plan-1', acceptanceVersion: 'accept-1',
      allowedPaths: ['.'], excludedPaths: [], rollbackReference: 'HEAD',
    }, ['read'])
    expect(guard({ name: 'write', arguments: { file_path: 'sandbox/output.txt' } } as ToolExecution)).toMatch(/does not permit write/)
  })

  it('rejects stages that own no specialist capability policy', () => {
    for (const stage of ['intake', 'ralph', 'closeout'] as const) {
      expect(() => toolRestrictionForStage(stage, ['read'])).toThrow(/capability policy/)
    }
  })
})
