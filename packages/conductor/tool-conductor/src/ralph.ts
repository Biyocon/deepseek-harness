/**
 * Conductor Ralph integration for the Headsman dispatch.
 *
 * Ralph is an internal Headsman primitive: when the run budget permits it, the
 * runtime executes the existing Ralph runner before the final Headsman child.
 * Ralph never passes Gate D or E itself — the Headsman's envelope still does.
 *
 * @module @deepseek-ai/dsh-tool-conductor/ralph
 */

/**
 * The Ralph directive to inject into a Headsman prompt, or undefined when Ralph
 * is disabled for the run.
 * @param maxRalphRounds - the run's Ralph round budget; a value below 1 disables Ralph.
 * @param skillBody - the `conductor-ralph` skill body, or undefined when unavailable.
 * @returns the directive text, or undefined when Ralph is disabled.
 */
export function ralphDirective(maxRalphRounds: number, skillBody: string | undefined): string | undefined {
  if (maxRalphRounds < 1) return undefined
  return [
    'Conductor already executed the bounded internal Ralph rounds and passes their result in your dispatch. Do not call a Ralph tool. Ralph is an execution primitive, not a gate: it never passes Gate D or E, and you still produce the final ImplementationReport yourself.',
    'Ralph rules:\n' + (skillBody ?? '(ralph skill body unavailable)'),
    `Ralph round budget: ${maxRalphRounds}. Stop on complete, blocked, or the round limit, then return your ImplementationReport.`,
  ].join('\n\n')
}
