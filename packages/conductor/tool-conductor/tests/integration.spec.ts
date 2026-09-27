import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkflowWorker from '@deepseek-ai/dsh-workflow-worker-thread'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as toolConductor from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** Extract the run id the Conductor tool embedded in one child's dispatch prompt. */
function promptText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('\n')
}

/** Extract the run id the Conductor tool embedded in one child's dispatch prompt. */
function extractRunId(options: GenerateOptions): string {
  const text = promptText(options)
  return /"run_id"\s*:\s*"(CON-\d{4}-\d{4})"/.exec(text)?.[1] ?? 'CON-0000-0000'
}

function readyEnvelope(runId: string, stage: string): Record<string, unknown> {
  return {
    run_id: runId,
    stage,
    baseline_ref: 'HEAD',
    ...(stage === 'detective' ? { source_baseline: 'HEAD' } : {}),
    status: 'ready',
    summary: `${stage} done`,
    evidence: [{ kind: 'test', reference: `${stage}-check`, outcome: 'passed' }],
    findings: [],
    assumptions: [],
    blockers: [],
    artifacts: [],
    change_requests: [],
    recommended_transition: { target: 'conductor', rationale: 'evaluate' },
    confidence: 'high',
    ...(stage === 'devils-advocate' ? {
      execution_baseline: {
        scopeVersion: 'scope-1',
        planVersion: 'plan-1',
        acceptanceVersion: 'accept-1',
        allowedPaths: ['packages/conductor'],
        excludedPaths: [],
        rollbackReference: 'HEAD',
      },
    } : {}),
  }
}

function goDecision(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    decision: 'go',
    basis: ['evidence meets criteria'],
    evidence_reviewed: ['delivery package'],
    conditions: [],
    open_risks: [],
    required_follow_up: [],
  }
}

describe('dsh-tool-conductor over the real spawn stack', () => {
  it('rejects a provider that cannot apply the required child persona', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const provider: SubagentProvider = {
      name: 'persona-less',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, toolGuard: true, persona: false },
      inheritsParentContext: false,
      start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
        throw new Error('persona-less provider must be rejected before start')
      },
    }
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(WorkflowWorker, { provider: provider.name })
    let failure: unknown
    try {
      await ctx.plugin(toolConductor, { subagentProvider: provider.name })
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/child personas/)
  })

  it('drives every specialist as a fresh child and returns the Arbiter GO decision', async () => {
    const beforeRalph = ['detective', 'strategist', 'devils-advocate'] as const
    const afterRalph = ['headsman', 'auditor', 'integrator'] as const
    const script: ((options: GenerateOptions) => ReturnType<typeof toolCallResponse>)[] = [
      ...beforeRalph.map(stage => (options: GenerateOptions) => {
        if (stage === 'strategist') expect(promptText(options)).toContain('detective done')
        return toolCallResponse(stage, STRUCTURED_OUTPUT_TOOL, readyEnvelope(extractRunId(options), stage))
      }),
      () => toolCallResponse('ralph-round', STRUCTURED_OUTPUT_TOOL, {
        status: 'complete',
        summary: 'bounded implementation round complete',
        evidence: ['Ralph worker evidence'],
        nextSteps: [],
        blocker: '',
      }),
      ...afterRalph.map(stage => (options: GenerateOptions) =>
        toolCallResponse(stage, STRUCTURED_OUTPUT_TOOL, readyEnvelope(extractRunId(options), stage))),
      (options: GenerateOptions) => {
        expect(promptText(options)).toContain('"specialist_reports"')
        expect(promptText(options)).toContain('integrator done')
        return toolCallResponse('arbiter', STRUCTURED_OUTPUT_TOOL, goDecision(extractRunId(options)))
      },
    ]
    const ctx = new Context()
    const adapter = new MockAdapter(script)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(WorkflowWorker, { provider: 'spawn' })
    ctx.on('session/flush', () => {})
    for (const name of [
      'conductor-detective', 'conductor-strategist', 'conductor-devils-advocate',
      'conductor-headsman', 'conductor-auditor', 'conductor-integrator', 'conductor-arbiter',
      'conductor-specialist', 'conductor-ralph', 'conductor-closeout',
    ]) {
      ctx.skills.register({ name, description: name, content: `${name} instructions`, source: 'test' })
    }
    await ctx.plugin(toolConductor, { subagentProvider: 'spawn', maxRalphRounds: 1 })
    for (const name of ['read', 'read_image', 'grep', 'glob', 'write', 'edit']) {
      ctx.tools.register(defineContentToolFixture({
        name, description: name, parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: name }]),
      }))
    }
    ctx.llm.registerAdapter(['mock'], adapter)

    const parent = ctx.agentLoop.create(SessionId('conductor-parent'), { provider: 'mock', model: 'mock' })
    const children: Agent[] = []
    ctx.on('subagent/start', (info) => {
      const agent = ctx.agents.get(info.id)
      if (agent !== undefined) children.push(agent)
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('conductor-integration'),
      name: 'conductor',
      arguments: {
        objective: 'Ship the feature through the full gate chain.',
        acceptanceCriteria: ['all specialist gates have evidence'],
        allowedPaths: ['packages/conductor'],
        authority: { owner: 'user', permittedActions: ['read', 'write'] },
      },
      agent: parent,
    })

    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('Conductor reached the Arbiter')
    expect(children).toHaveLength(8)
    for (const child of children) {
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }

    const checkpoint = parent.session.events.filter(event => event.type === 'conductor/checkpoint').at(-1)
    expect(checkpoint).toBeDefined()
    if (checkpoint?.type !== 'conductor/checkpoint') throw new Error('missing Conductor checkpoint')
    const closed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('conductor-closeout'),
      name: 'conductor',
      arguments: {
        runId: checkpoint.data.runId,
        objective: 'Ship the feature through the full gate chain.',
        allowedPaths: ['packages/conductor'],
        authority: { owner: 'user', permittedActions: ['read', 'write'] },
        closeoutAuthorization: {
          authorizedBy: 'user',
          action: 'record-only',
          actionsTaken: ['recorded the verified GO'],
          outcomeEvidence: ['Gate G checkpoint'],
          unverifiedItems: [],
          openRisks: [],
          followUp: [],
          traceability: {
            mandate: ['tool input'], baseline: ['HEAD'], changes: [],
            verification: ['Auditor envelope'], decision: ['Gate G'],
          },
        },
      },
      agent: parent,
    })
    expect(closed.isError, JSON.stringify(closed)).toBe(false)
    expect((closed.content[0] as { text: string }).text).toContain('Conductor run closed')

    const blankCriterion = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('conductor-blank-criterion'),
      name: 'conductor',
      arguments: {
        objective: 'Reject blank criteria before dispatch.',
        acceptanceCriteria: [''],
        authority: { owner: 'user', permittedActions: ['read'] },
      },
      agent: parent,
    })
    expect(blankCriterion.isError).toBe(true)
    expect((blankCriterion.content[0] as { text: string }).text).toMatch(/acceptanceCriteria.*non-empty normalized strings/)
  }, 15_000)
})
