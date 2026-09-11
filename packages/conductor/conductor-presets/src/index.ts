/**
 * Conductor specialist role-skill metadata.
 *
 * The shipped preset composition
 * (`apps/cli/config/agent-presets/conductor/agent.cordis.yml`) loads the
 * specialist role files under {@link ROLE_DIR} as skills through
 * `dsh-skill-filesystem`. Each role file carries frontmatter naming one of
 * {@link ROLE_SKILL_NAMES}; the model-facing tool resolves the matching name
 * per stage and injects its body into the spawned specialist child. The role
 * files themselves are not model- or user-invocable.
 *
 * @module @deepseek-ai/dsh-conductor-presets
 */

/** Directory holding the specialist role files, relative to the repository root. */
export const ROLE_DIR = '.agents/conductor/roles'

/**
 * Specialist stage name → role skill name, in gate order (Detective through
 * The Arbiter). Keys are the seven gated `ConductorStage` values.
 */
export const ROLE_SKILL: Readonly<Record<string, string>> = {
  detective: 'conductor-detective',
  strategist: 'conductor-strategist',
  'devils-advocate': 'conductor-devils-advocate',
  headsman: 'conductor-headsman',
  auditor: 'conductor-auditor',
  integrator: 'conductor-integrator',
  arbiter: 'conductor-arbiter',
}

/** Every role skill name, in gate order. */
export const ROLE_SKILL_NAMES: readonly string[] = Object.values(ROLE_SKILL)
