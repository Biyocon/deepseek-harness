/**
 * Conductor stage capability policies for the tool.
 *
 * Each specialist stage maps to a {@link ToolRestriction} the tool applies to
 * the spawned child. Read-only stages keep only the read/search tools; the
 * Integrator keeps read plus write/edit but no shell (so it cannot commit); the
 * Headsman has no tool restriction because it implements and runs checks — its
 * write surface is bounded by the execution baseline's `allowed_paths` via the
 * filesystem policy, and no specialist may commit, push, or merge because those
 * actions require the mandate owner's explicit authority, never a gate pass.
 *
 * @module @deepseek-ai/dsh-tool-conductor/capability
 */

import type { ConductorStage } from '@deepseek-ai/dsh-conductor'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/** Global read/search tool names a read-only specialist keeps visible. */
export const READ_TOOLS = ['read', 'read_image', 'grep', 'glob'] as const

/** Global write/edit tool names the Integrator keeps alongside the read tools. */
export const WRITE_TOOLS = ['write', 'edit'] as const

/**
 * The tool restriction for a specialist stage, or undefined when the stage has
 * no name-level restriction (the Headsman, whose writes the filesystem policy
 * bounds to the baseline's `allowed_paths`).
 *
 * Detective, Strategist, Devil's Advocate, Auditor, and Arbiter are read-only;
 * the Integrator may write but not run a shell.
 * @param stage - the stage being dispatched.
 * @returns the restriction to apply as the child's `toolFilter`, or undefined.
 */
export function toolRestrictionForStage(stage: ConductorStage): ToolRestriction | undefined {
  switch (stage) {
    case 'detective':
    case 'strategist':
    case 'devils-advocate':
    case 'auditor':
    case 'arbiter':
      return { allow: [...READ_TOOLS] }
    case 'headsman':
      return undefined
    case 'integrator':
      return { allow: [...READ_TOOLS, ...WRITE_TOOLS] }
    case 'intake':
    case 'ralph':
    case 'closeout':
      throw new Error(`stage "${stage}" owns no specialist capability policy`)
  }
}
