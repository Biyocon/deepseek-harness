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
  closeRun,
  createRun,
  drive,
  isValidRunId,
  mintRunId,
  resumeRun,
  SessionConductorRunStore,
} from '@deepseek-ai/dsh-conductor'
import type {
  ConductorAction,
  ConductorAuthority,
  ConductorRun,
  ConductorStage,
  CloseoutAuthorization,
  DecisionRecord,
  SpecialistEnvelope,
} from '@deepseek-ai/dsh-conductor'
import { toolGuardForStage, toolRestrictionForStage } from './capability.ts'
import { ralphDirective } from './ralph.ts'
import { ROLE_SKILL } from '@deepseek-ai/dsh-conductor-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'
import { runRalphWorkflow } from '@deepseek-ai/dsh-tool-ralph'
// Declaration merge only: makes ctx.skills visible for the role-skill lookup.
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'tool-conductor'
export const inject = ['tools', 'subagents', 'skills', 'sessions', 'workflowEngine']

/** Deployment policy for the Conductor tool. */
export interface Config {
  /** Fresh structured-output subagent provider (default `spawn`). */
  subagentProvider?: string
  /** Default rework budget when a call names none (default 3). */
  maxReworkCycles?: number
  /** Default Ralph round budget; 0 disables the Headsman sub-phase (default 0). */
  maxRalphRounds?: number
  /** Maximum serialized characters in one Ralph handoff (default 16384). */
  maxRalphHandoffChars?: number
}

/** Schemastery configuration for the Conductor tool. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  maxReworkCycles: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  maxRalphRounds: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  maxRalphHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly maxReworkCycles: number
  readonly maxRalphRounds: number
  readonly maxRalphHandoffChars: number
}

interface ConductorCallArgs {
  objective: string
  scope?: string[]
  inputArtifacts?: string[]
  allowedPaths?: string[]
  excludedPaths?: string[]
  sourceBaseline?: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  authority?: { owner: string; permittedActions: string[] }
  runId?: string
  closeoutAuthorization?: CloseoutAuthorization
}

const VALID_ACTIONS = ['read', 'write', 'commit', 'push', 'merge', 'release', 'publish', 'deploy'] as const

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
    baseline_ref: { type: 'string' },
    source_baseline: { type: 'string' },
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
    execution_baseline: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scopeVersion: { type: 'string' },
        planVersion: { type: 'string' },
        acceptanceVersion: { type: 'string' },
        allowedPaths: { type: 'array', items: { type: 'string' } },
        excludedPaths: { type: 'array', items: { type: 'string' } },
        rollbackReference: { type: 'string' },
      },
      required: [
        'scopeVersion', 'planVersion', 'acceptanceVersion', 'allowedPaths', 'excludedPaths', 'rollbackReference',
      ],
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
    'run_id', 'stage', 'baseline_ref', 'status', 'summary', 'evidence', 'findings', 'assumptions',
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
  const maxRalphHandoffChars = config.maxRalphHandoffChars ?? 16_384
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  if (!Number.isSafeInteger(maxReworkCycles) || maxReworkCycles < 1) {
    throw new TypeError('maxReworkCycles must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxRalphRounds) || maxRalphRounds < 0) {
    throw new TypeError('maxRalphRounds must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxRalphHandoffChars) || maxRalphHandoffChars < 1) {
    throw new TypeError('maxRalphHandoffChars must be a positive safe integer')
  }
  return { subagentProvider, maxReworkCycles, maxRalphRounds, maxRalphHandoffChars }
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
  if (!provider.capabilities.toolGuard) {
    throw new Error(`Conductor subagent provider "${name}" does not support argument-aware tool guards`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`Conductor subagent provider "${name}" does not support child personas`)
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

function resolvePathList(value: string[] | undefined, field: string): string[] {
  const paths = value ?? []
  if (paths.some(path => path.length === 0 || path !== path.trim())) {
    throw new Error(`Conductor ${field} must contain only non-empty normalized paths`)
  }
  if (new Set(paths).size !== paths.length) throw new Error(`Conductor ${field} must not contain duplicates`)
  return [...paths]
}

function resolveStringList(value: string[] | undefined, field: string): string[] {
  const items = value ?? []
  if (items.some(item => item.length === 0 || item !== item.trim())) {
    throw new Error(`Conductor ${field} must contain only non-empty normalized strings`)
  }
  if (new Set(items).size !== items.length) throw new Error(`Conductor ${field} must not contain duplicates`)
  return [...items]
}

/** Compose the specialist child prompt from the role skill body, the dispatch package, and an optional Ralph directive. */
function composeSpecialistPrompt(
  stage: ConductorStage,
  run: ConductorRun,
  ralphResult?: unknown,
): string {
  const stageActions: ConductorAction[] = [
    ...(run.authority.permittedActions.includes('read') ? ['read' as const] : []),
    ...((stage === 'headsman' || stage === 'integrator') && run.authority.permittedActions.includes('write')
      ? ['write' as const]
      : []),
  ]
  const parts = [
    'You are one specialist in a Conductor run. Work only on the dispatched stage, against the dispatch package below, and return exactly one structured result to the Conductor. You are a worker, not the workflow owner: never name the next specialist and never make a gate decision.',
    'Dispatch package:\n' + JSON.stringify({
      run_id: run.runId,
      stage,
      objective: run.objective,
      scope: run.scope,
      previous_specialist_reports: run.specialistReports,
      source_baseline: run.sourceBaseline,
      execution_baseline: run.baseline,
      allowed_paths: run.allowedPaths,
      excluded_paths: run.excludedPaths,
      allowed_actions: stageActions,
      prohibited_actions: [...VALID_ACTIONS.filter(action => !stageActions.includes(action)), 'shell'],
      acceptance_criteria: run.acceptanceCriteria,
      constraints: run.constraints,
      input_artifacts: run.inputArtifacts,
      questions_to_resolve: [],
      required_evidence: [],
    }, null, 2),
    'Return the structured result in exactly the fields the schema requires.',
  ]
  if (ralphResult !== undefined) {
    parts.splice(parts.length - 1, 0,
      `Headsman-internal Ralph result (not a gate decision):\n${JSON.stringify(ralphResult, null, 2)}`)
  }
  return parts.join('\n\n')
}

/** Compose the Arbiter child prompt from the complete delivery record and gate history. */
function composeArbiterPrompt(run: ConductorRun): string {
  return [
    'You are The Arbiter in a Conductor run. Review the full gate history and delivery package, then return a GO/NO-GO decision. A GO never grants commit, push, merge, or deploy authority by itself.',
    'Run, specialist reports, and gate history:\n' + JSON.stringify({
      run_id: run.runId,
      source_baseline: run.sourceBaseline,
      execution_baseline: run.baseline,
      specialist_reports: run.specialistReports,
      history: run.history,
    }, null, 2),
    'Acceptance criteria:\n' + JSON.stringify(run.acceptanceCriteria, null, 2),
    'Return the DecisionRecord in exactly the fields the schema requires.',
  ].join('\n\n')
}

const SPECIALIST_WORKFLOW_META = {
  name: 'conductor-specialist',
  description: 'Run one fresh Conductor specialist through the workflow engine.',
  phases: [{ title: 'Specialist', detail: 'One policy-scoped structured-output child.' }],
}

const SPECIALIST_WORKFLOW_SCRIPT = String.raw`
phase('Specialist')
return await agent(args.prompt, {
  label: args.label,
  schema: args.schema,
})
`

/** Load one required scoped skill or fail the dispatch before a child starts. */
async function requireSkill(ctx: Context, parent: Agent, signal: AbortSignal, name: string): Promise<string> {
  const skill = await ctx.skills.get(name, {
    scope: parent.ctx,
    cwd: parent.session.header.cwd,
    signal,
  })
  if (skill === undefined) throw new Error(`Conductor required skill "${name}" is unavailable`)
  return skill.content
}

/** Run one fresh structured child through the existing workflow engine. */
async function runWorkflowChild(
  ctx: Context,
  providerName: string,
  parent: Agent,
  signal: AbortSignal,
  stage: ConductorStage,
  run: ConductorRun,
  prompt: string,
  schema: ObjectJsonSchema,
  persona: string,
): Promise<unknown> {
  const workflow: WorkflowRun = ctx.workflowEngine.start({
    script: SPECIALIST_WORKFLOW_SCRIPT,
    meta: SPECIALIST_WORKFLOW_META,
    args: { prompt, label: `conductor-${stage}`, schema },
    subagentProvider: providerName,
    maxTotalAgents: 1,
    parent,
    signal,
    childToolFilter: toolRestrictionForStage(stage, run.authority.permittedActions),
    childToolGuard: toolGuardForStage(stage, run.baseline, run.authority.permittedActions),
    childPersona: persona,
  })
  try {
    const result: WorkflowResult = await workflow.result
    if (result.stopReason !== 'completed') return undefined
    return result.value
  } finally {
    await workflow.dispose()
  }
}

/** Read one specialist's structured envelope across the subagent boundary. */
async function runSpecialist(
  ctx: Context,
  providerName: string,
  parent: Agent,
  signal: AbortSignal,
  stage: ConductorStage,
  run: ConductorRun,
  maxRalphHandoffChars: number,
): Promise<SpecialistEnvelope> {
  const roleName = ROLE_SKILL[stage]
  if (roleName === undefined) throw new Error(`Conductor stage "${stage}" has no role skill`)
  const [roleBody, specialistBody] = await Promise.all([
    requireSkill(ctx, parent, signal, roleName),
    requireSkill(ctx, parent, signal, 'conductor-specialist'),
  ])
  let ralphBody: string | undefined
  if (stage === 'headsman') {
    const ralphSkill = run.budget.maxRalphRounds > 0
      ? await requireSkill(ctx, parent, signal, 'conductor-ralph')
      : undefined
    ralphBody = ralphDirective(run.budget.maxRalphRounds, ralphSkill)
  }
  const persona = [roleBody, specialistBody, ralphBody].filter(value => value !== undefined).join('\n\n')
  const ralphOutcome = stage === 'headsman' && run.budget.maxRalphRounds > 0
    ? await runRalphWorkflow(ctx, {
      objective: `Implement the approved Conductor baseline for: ${run.objective}`,
      maxRounds: run.budget.maxRalphRounds,
      maxHandoffChars: maxRalphHandoffChars,
      maxResultChars: maxRalphHandoffChars,
      subagentProvider: providerName,
      parent,
      signal,
      childToolFilter: toolRestrictionForStage(stage, run.authority.permittedActions),
      childToolGuard: toolGuardForStage(stage, run.baseline, run.authority.permittedActions),
      childPersona: persona,
    })
    : undefined
  const structured = await runWorkflowChild(
    ctx, providerName, parent, signal, stage, run,
    composeSpecialistPrompt(stage, run, ralphOutcome?.result), ENVELOPE_SCHEMA, persona,
  )
  if (structured === undefined || structured === null) {
    return {
      run_id: run.runId,
      stage,
      status: 'failed',
      baseline_ref: run.baseline?.rollbackReference ?? run.sourceBaseline ?? 'unestablished',
      summary: 'specialist produced no structured envelope',
      evidence: [],
      findings: [],
      assumptions: [],
      blockers: ['workflow child returned no structured value'],
      artifacts: [],
      change_requests: [],
      recommended_transition: { target: 'conductor', rationale: 'no structured output' },
      confidence: 'low',
    }
  }
  return structured as SpecialistEnvelope
}

/** Read the Arbiter's decision across the subagent boundary. */
async function runArbiter(
  ctx: Context,
  providerName: string,
  parent: Agent,
  signal: AbortSignal,
  run: ConductorRun,
): Promise<DecisionRecord> {
  const arbiterRole = ROLE_SKILL['arbiter']
  if (arbiterRole === undefined) throw new Error('Conductor Arbiter role skill mapping is unavailable')
  const [roleBody, closeoutBody] = await Promise.all([
    requireSkill(ctx, parent, signal, arbiterRole),
    requireSkill(ctx, parent, signal, 'conductor-closeout'),
  ])
  const structured = await runWorkflowChild(
    ctx, providerName, parent, signal, 'arbiter', run,
    composeArbiterPrompt(run), DECISION_SCHEMA, `${roleBody}\n\n${closeoutBody}`,
  )
  if (structured === undefined || structured === null) {
    return {
      run_id: run.runId,
      decision: 'no-go',
      basis: ['arbiter produced no structured decision'],
      evidence_reviewed: [],
      conditions: [],
      open_risks: ['workflow child returned no structured value'],
      required_follow_up: ['re-dispatch arbiter'],
    }
  }
  return structured as DecisionRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Render the terminal outcome without presenting self-report as certification. */
function renderOutcome(value: unknown): string {
  if (isRecord(value) && value['kind'] === 'decision') {
    return `Conductor reached the Arbiter.\nDecision:\n${JSON.stringify(value['decision'], null, 2)}`
  }
  if (isRecord(value) && value['kind'] === 'blocked') {
    return `Conductor run blocked: ${String(value['blocker'])}`
  }
  if (isRecord(value) && value['kind'] === 'closeout') {
    return `Conductor run closed.\nCloseout:\n${JSON.stringify(value['closeout'], null, 2)}`
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
      scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files, components, or concerns included in the run.',
      },
      inputArtifacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Artifact paths or identifiers available to every specialist.',
      },
      allowedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Owner-authorized roots that write-capable stages may modify; omission authorizes no writes.',
      },
      excludedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Owner-declared roots excluded from every specialist write.',
      },
      sourceBaseline: {
        type: 'string',
        description: 'Optional source version or commit observed at intake; Detective establishes it when omitted.',
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
        description: 'The mandate owner and permitted external actions (read/write/commit/push/merge/release/publish/deploy).',
      },
      runId: {
        type: 'string',
        description: 'Optional run id to resume an existing unfinished run.',
      },
      closeoutAuthorization: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authorizedBy: { type: 'string', required: true },
          action: {
            type: 'string',
            required: true,
            enum: ['record-only', ...VALID_ACTIONS],
          },
          outcomeEvidence: { type: 'array', required: true, items: { type: 'string' } },
          actionsTaken: { type: 'array', required: true, items: { type: 'string' } },
          unverifiedItems: { type: 'array', required: true, items: { type: 'string' } },
          openRisks: { type: 'array', required: true, items: { type: 'string' } },
          followUp: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                owner: { type: 'string', required: true },
                dueCondition: { type: 'string', required: true },
              },
            },
          },
          traceability: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              mandate: { type: 'array', required: true, items: { type: 'string' } },
              baseline: { type: 'array', required: true, items: { type: 'string' } },
              changes: { type: 'array', required: true, items: { type: 'string' } },
              verification: { type: 'array', required: true, items: { type: 'string' } },
              decision: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
        description: 'Explicit owner authorization used only to close a prior Arbiter GO; Conductor records but never performs the action.',
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
      const allowedPaths = resolvePathList(call.allowedPaths, 'allowedPaths')
      const excludedPaths = resolvePathList(call.excludedPaths, 'excludedPaths')
      const store = new SessionConductorRunStore(parent.session, async () => {
        const flushed = await ctx.sessions.flush(parent.session)
        if (!flushed) throw new Error(`Conductor could not durably flush session ${parent.session.id}`)
      })

      let run: ConductorRun
      if (call.runId !== undefined) {
        if (!isValidRunId(call.runId)) throw new Error(`Conductor runId "${call.runId}" is not a valid CON-YYYY-NNNN id`)
        run = await resumeRun(store, ConductorRunId(call.runId))
        if (run.objective !== objective) throw new Error('Conductor resume objective does not match the persisted run')
        if (run.authority.owner !== authority.owner
          || run.authority.permittedActions.join('\0') !== authority.permittedActions.join('\0')) {
          throw new Error('Conductor resume authority does not match the persisted run')
        }
        if (!sameOrderedStrings(run.allowedPaths, allowedPaths)) {
          throw new Error('Conductor resume allowedPaths do not match the persisted run')
        }
        if (!sameOrderedStrings(run.excludedPaths, excludedPaths)) {
          throw new Error('Conductor resume excludedPaths do not match the persisted run')
        }
      } else {
        if (call.closeoutAuthorization !== undefined) {
          throw new Error('Conductor closeoutAuthorization requires an existing runId')
        }
        let runId = mintRunId()
        for (let attempt = 0; attempt < 8 && (await store.load(runId)) !== undefined; attempt += 1) {
          runId = mintRunId()
        }
        run = createRun(runId, {
          objective,
          scope: resolveStringList(call.scope, 'scope'),
          inputArtifacts: resolveStringList(call.inputArtifacts, 'inputArtifacts'),
          allowedPaths,
          excludedPaths,
          ...call.sourceBaseline !== undefined ? { sourceBaseline: call.sourceBaseline } : {},
          authority,
          constraints: resolveStringList(call.constraints, 'constraints'),
          acceptanceCriteria: resolveStringList(call.acceptanceCriteria, 'acceptanceCriteria'),
          budget: { maxReworkCycles: resolved.maxReworkCycles, maxRalphRounds: resolved.maxRalphRounds },
        })
        await store.save(run)
      }

      if (run.currentStage === 'closeout') {
        if (call.closeoutAuthorization === undefined) {
          return {
            runId: run.runId,
            stage: run.currentStage,
            status: run.status,
            result: {
              kind: 'blocked',
              blocker: 'Arbiter GO recorded; explicit closeoutAuthorization is required to close the run',
            } as unknown as JsonValue,
          }
        }
        const closed = closeRun(run, call.closeoutAuthorization)
        await store.save(closed)
        return {
          runId: closed.runId,
          stage: closed.currentStage,
          status: closed.status,
          result: { kind: 'closeout', closeout: closed.closeout } as unknown as JsonValue,
        }
      }
      if (call.closeoutAuthorization !== undefined) {
        throw new Error('Conductor closeoutAuthorization is valid only after an Arbiter GO')
      }

      const dispatcher = {
        async dispatchSpecialist(stage: ConductorStage, current: ConductorRun) {
          return await runSpecialist(
            ctx, resolved.subagentProvider, parent, exec.signal, stage, current, resolved.maxRalphHandoffChars,
          )
        },
        async dispatchArbiter(current: ConductorRun) {
          return await runArbiter(ctx, resolved.subagentProvider, parent, exec.signal, current)
        },
      }

      const outcome = await drive(run, dispatcher, async (checkpoint) => {
        await store.save(checkpoint)
      })

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
