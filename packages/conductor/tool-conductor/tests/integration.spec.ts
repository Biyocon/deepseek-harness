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
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as toolConductor from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** Extract the run id the Conductor tool embedded in one child's dispatch prompt. */
function extractRunId(options: GenerateOptions): string {
  const text = options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('\n')
  return /"run_id"\s*:\s*"(CON-\d{4}-\d{4})"/.exec(text)?.[1] ?? 'CON-0000-0000'
}

function readyEnvelope(runId: string, stage: string): Record<string, unknown> {
  return {
    run_id: runId,
    stage,
    status: 'ready',
    summary: `${stage} done`,
    evidence: [],
    findings: [],
    assumptions: [],
    blockers: [],
    artifacts: [],
    change_requests: [],
    recommended_transition: { target: 'conductor', rationale: 'evaluate' },
    confidence: 'high',
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
  it('drives every specialist as a fresh child and returns the Arbiter GO decision', async () => {
    const stages = ['detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'integrator'] as const
    const script: ((options: GenerateOptions) => ReturnType<typeof toolCallResponse>)[] = [
      ...stages.map(stage => (options: GenerateOptions) =>
        toolCallResponse(stage, STRUCTURED_OUTPUT_TOOL, readyEnvelope(extractRunId(options), stage))),
      (options: GenerateOptions) =>
        toolCallResponse('arbiter', STRUCTURED_OUTPUT_TOOL, goDecision(extractRunId(options))),
    ]
    const ctx = new Context()
    const adapter = new MockAdapter(script)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(toolConductor, { subagentProvider: 'spawn' })
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
        authority: { owner: 'user', permittedActions: ['read'] },
      },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('Conductor reached the Arbiter')
    expect(children).toHaveLength(7)
    for (const child of children) {
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }
  })
})
