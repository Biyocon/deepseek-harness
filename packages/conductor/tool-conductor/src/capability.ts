/**
 * Conductor stage capability policies for the tool.
 *
 * Each specialist stage maps to a {@link ToolRestriction} the tool applies to
 * the spawned child. Read-only stages keep only the read/search tools; the
 * Integrator and Headsman keep read plus write/edit but no shell. Their write
 * targets are checked against canonical filesystem paths from the execution
 * baseline, and no specialist receives a commit, push, or merge tool.
 *
 * @module @deepseek-ai/dsh-tool-conductor/capability
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ConductorAction, ConductorStage, ExecutionBaseline } from '@deepseek-ai/dsh-conductor'
import type { ToolExecution, ToolGuard, ToolRestriction } from '@deepseek-ai/dsh-tools'

/** Global read/search tool names a read-only specialist keeps visible. */
export const READ_TOOLS = ['read', 'read_image', 'grep', 'glob'] as const

/** Global write/edit tool names the Integrator keeps alongside the read tools. */
export const WRITE_TOOLS = ['write', 'edit'] as const

/** Tools available to Headsman; shell tools stay absent so Git/release actions cannot execute. */
export const IMPLEMENTATION_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS] as const

/**
 * The tool restriction for a specialist stage.
 *
 * Detective, Strategist, Devil's Advocate, Auditor, and Arbiter are read-only;
 * the Integrator may write but not run a shell.
 * @param stage - the stage being dispatched.
 * @param permittedActions - mandate-owner actions for the run.
 * @returns the restriction to apply as the child's `toolFilter`.
 */
export function toolRestrictionForStage(
  stage: ConductorStage,
  permittedActions: readonly ConductorAction[],
): ToolRestriction {
  const read = permittedActions.includes('read') ? [...READ_TOOLS] : []
  const write = permittedActions.includes('write') ? [...WRITE_TOOLS] : []
  switch (stage) {
    case 'detective':
    case 'strategist':
    case 'devils-advocate':
    case 'auditor':
    case 'arbiter':
      return { allow: read }
    case 'headsman':
      return { allow: [...read, ...write] }
    case 'integrator':
      return { allow: [...read, ...write] }
    case 'intake':
    case 'ralph':
    case 'closeout':
      throw new Error(`stage "${stage}" owns no specialist capability policy`)
  }
}

/**
 * Build the argument-aware write guard for one specialist child. Reads are
 * unaffected. Headsman writes only inside the immutable execution baseline;
 * Integrator is further limited to `docs` or `.agents/notes` descendants.
 * @param stage - dispatched specialist stage.
 * @param baseline - Gate-C execution baseline, required by write-capable stages.
 * @param permittedActions - mandate-owner actions for the run.
 * @returns a monotonic child-scoped tool guard.
 */
export function toolGuardForStage(
  stage: ConductorStage,
  baseline: ExecutionBaseline | null,
  permittedActions: readonly ConductorAction[],
): ToolGuard {
  if (stage === 'headsman' || stage === 'integrator') {
    if (baseline === null) throw new Error(`${stage} requires an approved execution baseline`)
    if (!permittedActions.includes('write')) {
      return exec => (WRITE_TOOLS as readonly string[]).includes(exec.name)
        ? `Conductor ${stage} write denied: mandate does not permit write`
        : undefined
    }
    return exec => writePolicyDenial(exec, stage, baseline)
  }
  return () => undefined
}

function writePolicyDenial(
  exec: Readonly<ToolExecution>,
  stage: 'headsman' | 'integrator',
  baseline: ExecutionBaseline,
): string | undefined {
  if (!(WRITE_TOOLS as readonly string[]).includes(exec.name)) return undefined
  const candidate = isRecord(exec.arguments) ? exec.arguments['file_path'] : undefined
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return `Conductor ${stage} write policy requires file_path`
  }
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  let target: string
  let allowedRoots: string[]
  let excludedRoots: string[]
  try {
    target = canonicalAbsolute(cwd, candidate)
    allowedRoots = baseline.allowedPaths.map(path => canonicalAbsolute(cwd, path))
    excludedRoots = baseline.excludedPaths.map(path => canonicalAbsolute(cwd, path))
  } catch (error) {
    return `Conductor ${stage} write denied: path could not be canonicalized (${String(error)})`
  }
  const excluded = excludedRoots.some(path => contains(path, target))
  if (excluded) return `Conductor ${stage} write denied: path is excluded by the execution baseline`
  const allowed = allowedRoots.some(path => contains(path, target))
  if (!allowed) return `Conductor ${stage} write denied: path is outside allowed_paths`
  if (stage === 'integrator' && !isDocumentationPath(canonicalAbsolute(cwd, cwd), target)) {
    return 'Conductor integrator write denied: path is outside docs/notes'
  }
  return undefined
}

function canonicalAbsolute(cwd: string, path: string): string {
  const absolute = resolve(cwd, isAbsolute(path) ? path : resolve(cwd, path))
  const remainder: string[] = []
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error(`no existing ancestor for ${absolute}`)
    remainder.unshift(relative(parent, existing))
    existing = parent
  }
  return resolve(realpathSync.native(existing), ...remainder)
}

function contains(root: string, candidate: string): boolean {
  const comparisonRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparisonCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const suffix = relative(comparisonRoot, comparisonCandidate)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

function isDocumentationPath(cwd: string, target: string): boolean {
  const normalized = relative(cwd, target).split(sep).map(part => part.toLowerCase())
  return normalized.includes('docs')
    || normalized.some((part, index) => part === 'notes' && normalized[index - 1] === '.agents')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
