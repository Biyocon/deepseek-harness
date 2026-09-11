/**
 * Model-facing Conductor tool.
 *
 * The tool mints or resumes a run, then drives the gated specialist state
 * machine by spawning one fresh structured-output specialist per stage (role
 * skill injected from the mounted role loader), and returns the Arbiter's
 * {@link DecisionRecord} or a blocker. It never performs a commit, push, merge,
 * or deploy — a GO only records the decision and moves the run to closeout.
 *
 * @module @deepseek-ai/dsh-tool-conductor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ConductorRunId,
  createRun,
  drive,
  InMemoryConductorRunStore,
  isValidRunId,
  mintRunId,
  resumeRun,
} from '@deepseek-ai/dsh-conductor'
import type {
  ConductorAction,
  ConductorAuthority,
  ConductorRun,
  ConductorStage,
  DecisionRecord,
  SpecialistEnvelope,
} from '@deepseek-ai/dsh-conductor'
import { toolRestrictionForStage } from './capability.ts'
import { ralphDirective } from './ralph.ts'
import { ROLE_SKILL } from '@deepseek-ai/dsh-conductor-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
// Declaration merge only: makes ctx.skills visible for the role-skill lookup.
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'tool-conductor'
export const inject = ['tools', 'subagents', 'skills']

/** Deployment policy for the Conductor tool. */
export interface Config {
  /** Fresh structured-output subagent provider (default `spawn`). */
  subagentProvider?: string
  /** Default rework budget when a call names none (default 3). */
  maxReworkCycles?: number
  /** Default Ralph round budget; 0 disables the Headsman sub-phase (default 0). */
  maxRalphRounds?: number
}

/** Schemastery configuration for the Conductor tool. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  maxReworkCycles: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  maxRalphRounds: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly maxReworkCycles: number
  readonly maxRalphRounds: number
}

interface ConductorCallArgs {
  objective: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  authority?: { owner: string; permittedActions: string[] }
  runId?: string
}

const VALID_ACTIONS = ['read', 'write', 'commit', 'push', 'merge'] as const

const DESCRIPTION = 'Run a multi-role, gated Conductor workflow toward one objective. '
  + 'The tool drives Detective → Strategist → Devil\'s Advocate → Headsman → Auditor → Integrator → Arbiter, '
  + 'recording a gate decision after every specialist, and returns the Arbiter\'s GO/NO-GO decision or a blocker. '
  + 'A GO never commits, pushes, merges, or deploys on its own. Use when the user asks to run work through Conductor '
  + 'or wants a quality-gated multi-role execution.'

const ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string' },
    stage: { type: 'string' },
    status: { type: 'string', enum: ['ready', 'rework', 'blocked', 'failed'] },
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['command', 'file', 'test', 'review', 'external'] },
          reference: { type: 'string' },
          outcome: { type: 'string' },
        },
        required: ['kind', 'reference', 'outcome'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          description: { type: 'string' },
          impact: { type: 'string' },
        },
        required: ['id', 'severity', 'description', 'impact'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'string' } },
    change_requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', enum: ['scope', 'plan', 'baseline', 'authority'] },
          reason: { type: 'string' },
          impact: { type: 'string' },
        },
        required: ['target', 'reason', 'impact'],
      },
    },
    recommended_transition: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['conductor'] },
        rationale: { type: 'string' },
      },
      required: ['target', 'rationale'],
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: [
    'run_id', 'stage', 'status', 'summary', 'evidence', 'findings', 'assumptions',
    'blockers', 'artifacts', 'change_requests', 'recommended_transition', 'confidence',
  ],
} satisfies ObjectJsonSchema

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string' },
    decision: { type: 'string', enum: ['go', 'no-go'] },
    basis: { type: 'array', items: { type: 'string' } },
    evidence_reviewed: { type: 'array', items: { type: 'string' } },
    conditions: { type: 'array', items: { type: 'string' } },
    open_risks: { type: 'array', items: { type: 'string' } },
    required_follow_up: { type: 'array', items: { type: 'string' } },
  },
  required: ['run_id', 'decision', 'basis', 'evidence_reviewed', 'conditions', 'open_risks', 'required_follow_up'],
} satisfies ObjectJsonSchema

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const maxReworkCycles = config.maxReworkCycles ?? 3
  const maxRalphRounds = config.maxRalphRounds ?? 0
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  if (!Number.isSafeInteger(maxReworkCycles) || maxReworkCycles < 1) {
    throw new TypeError('maxReworkCycles must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxRalphRounds) || maxRalphRounds < 0) {
    throw new TypeError('maxRalphRounds must be a non-negative safe integer')
  }
  return { subagentProvider, maxReworkCycles, maxRalphRounds }
}

/** Require a genuinely fresh structured-output provider for specialists. */
function requireFreshProvider(ctx: Context, name: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(name)
  if (provider === undefined) {
    throw new Error(`Conductor subagent provider "${name}" is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`Conductor subagent provider "${name}" does not support structured output`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`Conductor subagent provider "${name}" does not support tool restrictions`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`Conductor subagent provider "${name}" inherits parent context; Conductor requires a fresh provider`)
  }
  return provider
}

/** Resolve and validate the model-supplied authority. */
function resolveAuthority(value: ConductorCallArgs['authority']): ConductorAuthority {
  const owner = value?.owner
  if (typeof owner !== 'string' || owner.length === 0 || owner !== owner.trim()) {
    throw new Error('Conductor authority requires a non-empty normalized owner')
  }
  const actions = value?.permittedActions
  if (actions === undefined) return { owner, permittedActions: ['read'] }
  if (!Array.isArray(actions) || !actions.every(a => typeof a === 'string' && (VALID_ACTIONS as readonly string[]).includes(a))) {
    throw new Error(`Conductor authority permittedActions must be a subset of ${VALID_ACTIONS.join(', ')}`)
  }
  return { owner, permittedActions: actions as ConductorAction[] }
}

/** Compose the specialist child prompt from the role skill body, the dispatch package, and an optional Ralph directive. */
function composeSpecialistPrompt(
  stage: ConductorStage,
  run: ConductorRun,
  roleBody: string | undefined,
  ralphBody?: string,
): string {
  const parts = [
    'You are one specialist in a Conductor run. Work only on the dispatched stage, against the dispatch package below, and return exactly one structured result to the Conductor. You are a worker, not the workflow owner: never name the next specialist and never make a gate decision.',
    'Specialist role:\n' + (roleBody ?? '(role body unavailable)'),
    'Dispatch package:\n' + JSON.stringify({
      run_id: run.runId,
      stage,
      objective: run.objective,
      baseline: run.baseline,
      allowed_actions: run.authority.permittedActions,
      acceptance_criteria: run.acceptanceCriteria,
      constraints: run.constraints,
    }, null, 2),
    'Return the structured result in exactly the fields the schema requires.',
  ]
  if (ralphBody !== undefined) parts.push(ralphBody)
  return parts.join('\n\n')
}

/** Compose the Arbiter child prompt from the role skill body and the full gate history. */
function composeArbiterPrompt(run: ConductorRun, roleBody: string | undefined): string {
  return [
    'You are The Arbiter in a Conductor run. Review the full gate history and delivery package, then return a GO/NO-GO decision. A GO never grants commit, push, merge, or deploy authority by itself.',
    'Arbiter role:\n' + (roleBody ?? '(role body unavailable)'),
    'Run and gate history:\n' + JSON.stringify({ run_id: run.runId, history: run.history }, null, 2),
    'Acceptance criteria:\n' + JSON.stringify(run.acceptanceCriteria, null, 2),
    'Return the DecisionRecord in exactly the fields the schema requires.',
  ].join('\n\n')
}

/** Read one specialist's structured envelope across the subagent boundary. */
async function runSpecialist(
  ctx: Context,
  providerName: string,
  parent: Agent,
  signal: AbortSignal,
  stage: ConductorStage,
  run: ConductorRun,
): Promise<SpecialistEnvelope> {
  const role = await ctx.skills.get(ROLE_SKILL[stage] ?? '', { signal })
  let ralphBody: string | undefined
  if (stage === 'headsman') {
    const ralphSkill = await ctx.skills.get('conductor-ralph', { signal })
    ralphBody = ralphDirective(run.budget.maxRalphRounds, ralphSkill?.content)
  }
  const prompt: ContentBlock[] = [{ type: 'text', text: composeSpecialistPrompt(stage, run, role?.content, ralphBody) }]
  const toolFilter = toolRestrictionForStage(stage)
  const child = await ctx.subagents.start(providerName, {
    prompt, parent, signal, outputSchema: ENVELOPE_SCHEMA,
    ...toolFilter !== undefined ? { toolFilter } : {},
  })
  const result = await child.result
  await child.dispose()
  if (result.structured === undefined) {
    return {
      run_id: run.runId,
      stage,
      status: 'failed',
      summary: `specialist produced no structured envelope (${result.stopReason})`,
      evidence: [],
      findings: [],
      assumptions: [],
      blockers: [result.stopReason],
      artifacts: [],
      change_requests: [],
      recommended_transition: { target: 'conductor', rationale: 'no structured output' },
      confidence: 'low',
    }
  }
  return result.structured as SpecialistEnvelope
}

/** Read the Arbiter's decision across the subagent boundary. */
async function runArbiter(
  ctx: Context,
  providerName: string,
  parent: Agent,
  signal: AbortSignal,
  run: ConductorRun,
): Promise<DecisionRecord> {
  const role = await ctx.skills.get(ROLE_SKILL['arbiter'] ?? '', { signal })
  const prompt: ContentBlock[] = [{ type: 'text', text: composeArbiterPrompt(run, role?.content) }]
  const toolFilter = toolRestrictionForStage('arbiter')
  const child = await ctx.subagents.start(providerName, {
    prompt, parent, signal, outputSchema: DECISION_SCHEMA,
    ...toolFilter !== undefined ? { toolFilter } : {},
  })
  const result = await child.result
  await child.dispose()
  if (result.structured === undefined) {
    return {
      run_id: run.runId,
      decision: 'no-go',
      basis: ['arbiter produced no structured decision'],
      evidence_reviewed: [],
      conditions: [],
      open_risks: [result.stopReason],
      required_follow_up: ['re-dispatch arbiter'],
    }
  }
  return result.structured as DecisionRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Render the terminal outcome without presenting self-report as certification. */
function renderOutcome(value: unknown): string {
  if (isRecord(value) && value['kind'] === 'decision') {
    return `Conductor reached the Arbiter.\nDecision:\n${JSON.stringify(value['decision'], null, 2)}`
  }
  if (isRecord(value) && value['kind'] === 'blocked') {
    return `Conductor run blocked: ${String(value['blocker'])}`
  }
  return 'Conductor run returned an unknown outcome'
}

function presentCall(args: ConductorCallArgs): ToolCallView {
  return { card: 'generic', title: 'conductor', rawInput: args.objective }
}

function presentResult(_args: ConductorCallArgs, _result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  return { card: 'generic' }
}

/** Register the Conductor tool and its gated specialist driver. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const store = new InMemoryConductorRunStore()
  requireFreshProvider(ctx, resolved.subagentProvider)

  ctx.tools.register(defineTool({
    name: 'conductor',
    description: DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The desired outcome for the Conductor run.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Non-negotiable constraints on the work.',
      },
      acceptanceCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Measurable criteria each gate pass is judged against.',
      },
      authority: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: 'string', required: true },
          permittedActions: { type: 'array', items: { type: 'string' } },
        },
        description: 'The mandate owner and permitted external actions (read/write/commit/push/merge).',
      },
      runId: {
        type: 'string',
        description: 'Optional run id to resume an existing unfinished run.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          stage: { type: 'string', required: true },
          status: { type: 'string', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value.result) }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('Conductor tool requires a calling agent (exec.agent was undefined)')
      }
      const call = args as unknown as ConductorCallArgs
      const objective = call.objective.trim()
      if (objective.length === 0) throw new Error('Conductor objective must be a non-empty string')
      const authority = resolveAuthority(call.authority)

      let run: ConductorRun
      if (call.runId !== undefined) {
        if (!isValidRunId(call.runId)) throw new Error(`Conductor runId "${call.runId}" is not a valid CON-YYYY-NNNN id`)
        run = await resumeRun(store, ConductorRunId(call.runId))
      } else {
        let runId = mintRunId()
        for (let attempt = 0; attempt < 8 && (await store.load(runId)) !== undefined; attempt += 1) {
          runId = mintRunId()
        }
        run = createRun(runId, {
          objective,
          authority,
          constraints: call.constraints ?? [],
          acceptanceCriteria: call.acceptanceCriteria ?? [],
          budget: { maxReworkCycles: resolved.maxReworkCycles, maxRalphRounds: resolved.maxRalphRounds },
        })
        await store.save(run)
      }

      const dispatcher = {
        async dispatchSpecialist(stage: ConductorStage, current: ConductorRun) {
          return await runSpecialist(ctx, resolved.subagentProvider, parent, exec.signal, stage, current)
        },
        async dispatchArbiter(current: ConductorRun) {
          return await runArbiter(ctx, resolved.subagentProvider, parent, exec.signal, current)
        },
      }

      const outcome = await drive(run, dispatcher)
      await store.save(outcome.run)

      return {
        runId: outcome.run.runId,
        stage: outcome.run.currentStage,
        status: outcome.run.status,
        result: (outcome.kind === 'decision'
          ? { kind: 'decision', decision: outcome.decision }
          : { kind: 'blocked', blocker: outcome.blocker }) as unknown as JsonValue,
      }
    },
    presentCall,
    presentResult,
  }))
}
