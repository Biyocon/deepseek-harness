/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-conductor`.
 * @module @deepseek-ai/dsh-conductor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseRun } from './persistence.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-conductor'

/** Cordis companion plugin name. */
export const name = 'conductor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateCheckpoint(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'conductor/checkpoint' || event.data.record === null) return
  try {
    const run = parseRun(event.data.record)
    if (run.runId !== event.data.runId) {
      fail(`conductor checkpoint key ${event.data.runId} does not match record ${run.runId}`)
    }
  } catch (error) {
    fail(`invalid conductor checkpoint: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Validate every existing and newly published Conductor checkpoint. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateCheckpoint(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [unknown, SessionEvent])[1]
    validateCheckpoint(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
