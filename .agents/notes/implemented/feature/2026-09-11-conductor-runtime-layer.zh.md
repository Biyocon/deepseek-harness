# Agent Note: Conductor runtime layer

Status: implemented

[English](2026-09-11-conductor-runtime-layer.md) | 中文

## Problem

Conductor 流程协议已经以四个本地 skill 的形式存在：[`conductor-orchestration`](../../../../.agents/skills/conductor-orchestration/SKILL.md)、[`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md)、[`conductor-ralph`](../../../../.agents/skills/conductor-ralph/SKILL.md) 和 [`conductor-closeout`](../../../../.agents/skills/conductor-closeout/SKILL.md)；七个专家角色文件位于 [`.agents/conductor/roles/`](../../../../.agents/conductor/README.md)。这些资产足以支持有纪律的手动或半自动 agent 工作，但它们还不是 runtime。目前在 DeepSeek Harness 中，没有任何东西能够自动：

- 生成或恢复持久的 `run_id`；
- 将专家结果通过 gate 决策进行路由；
- 强制 Detective 只读，而 Headsman 只能在授权范围内写入；
- 验证专家返回的结构化 envelope；
- 记录 gate 历史以便 Arbiter 查看所有先前决策；
- 将 Arbiter 与实施者隔离，或将 Auditor 与其自己的修复隔离。

没有 runtime 层，这些 skill 只是模型可能遵循的约定，而不是 harness 强制执行的保证。这个缺口变得越来越明显，因为用户现在希望说出“通过 Conductor 运行这个”，并让 gate、baseline 和 rework 自动发生。

## Decision

构建一个 Conductor workflow/runtime 功能，使用现有 skill 和角色文件作为指令，但在 DeepSeek Harness 内部实现状态、gate、路由和执行。该功能有四个具体部分：

1. **Conductor 状态机**（`packages/conductor/conductor`），拥有一个 run 的生命周期并持久化足够状态以在中断后恢复。
2. **面向模型的 Conductor 工具**（或基于 preset 的命令），启动 run，为每个子 agent 附加正确的角色文件，并将结果通过 gate 路由。
3. **Schema 验证的专家 envelope 和 gate 记录**，让 runtime 能够区分 `blocked` 的 Detective 与 `ready` 的 Headsman，并正确路由 rework。
4. **能力策略**，将每个 stage 映射到工具限制（只读、仅在 `allowed_paths` 内写入、禁止 commit/push/merge 等），由 subagent provider 强制执行，而不仅是提示文本。

该功能复用现有的 workflow 引擎、subagent provider、skill registry 和 preset 系统；它不会替换它们。

### 位置

Conductor runtime 应该是一个位于 `packages/` 下的新 package 组：

```
packages/conductor/
  conductor/          # run state machine + gate engine
  tool-conductor/     # model-facing tool (or workflow script wrapper)
  conductor-presets/  # optional preset composition for Conductor sessions
```

本提案将 Conductor 与通用的 workflow 引擎组分开，因为 Conductor 是一个面向用户的角色系统，而不是 workflow 原语。

### Run 状态

Run 是按 `run_id` 索引的持久状态。最小记录为：

```ts
interface ConductorRun {
  runId: string
  objective: string
  scope: string[]
  inputArtifacts: string[]
  allowedPaths: string[]
  excludedPaths: string[]
  sourceBaseline: string | null
  authority: {
    owner: 'user' | 'emperor' | string
    permittedActions: ('read' | 'write' | 'commit' | 'push' | 'merge' | 'release' | 'publish' | 'deploy')[]
  }
  constraints: string[]
  acceptanceCriteria: string[]
  budget: {
    maxReworkCycles: number
    maxRalphRounds: number
  }
  baseline: {
    scopeVersion: string
    planVersion: string
    acceptanceVersion: string
    allowedPaths: string[]
    excludedPaths: string[]
    rollbackReference: string
  } | null
  currentStage: ConductorStage
  history: GateRecord[]
  specialistReports: SpecialistEnvelope[]
  status: 'running' | 'awaiting_authorization' | 'rework' | 'escalated' | 'closed' | 'aborted'
}

type ConductorStage =
  | 'intake'
  | 'detective'
  | 'strategist'
  | 'devils-advocate'
  | 'headsman'
  | 'ralph'
  | 'auditor'
  | 'integrator'
  | 'arbiter'
  | 'closeout'

interface GateRecord {
  gate: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'
  stage: ConductorStage
  decision: 'pass' | 'rework' | 'escalate' | 'abort'
  basis: string[]
  evidenceReviewed: string[]
  defectClass?: 'scope' | 'plan' | 'implementation' | 'delivery'
  nextStage?: ConductorStage
  stateUpdate: string
}
```

Runtime 在父 session log 中使用现有 session 事件持久化此记录，和/或在按 `run_id` 索引的小型 host-side store 中持久化。冷恢复读取最新的 gate 记录并从该 stage 重启，绝不会从未记录的状态启动。

### Stage 路由

Run 按照 [`conductor-orchestration`](../../../../.agents/skills/conductor-orchestration/SKILL.md) 中的 gate 前进：

| Gate | Stage | Passes to | 按缺陷类别的 rework 目标 |
|------|-------|-----------|--------------------------|
| A | Detective | Strategist | Detective（scope） |
| B | Strategist | Devil's Advocate | Strategist（plan） |
| C | Devil's Advocate | Headsman | Strategist，然后新的 Devil's Advocate |
| D | Headsman | Auditor | Headsman（implementation） |
| E | Auditor | Integrator | 按缺陷类别到 Headsman、Strategist 或 Detective |
| F | Integrator | Arbiter | Integrator 或 owner |
| G | Arbiter | closeout | 相关 owner 或 escalation |

Conductor 状态机是决定 `nextStage` 的唯一代码。专家结果只携带 `recommended_transition: { target: 'conductor', rationale }`；它从不命名下一个专家。

### 专家分发

每个专家都是一个全新的 `spawn` 子 agent，具有：

- 从 [`.agents/conductor/roles/`](../../../../.agents/conductor/README.md) 加载的对应角色文件作为 per-child persona 或作为 skill body 注入；
- 注入的 [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md) skill，让子 agent 知道 envelope 格式；
- 匹配 stage 的工具限制（Detective/Auditor/Arbiter 只读；Headsman 写入限制在 `allowed_paths`；任何人都没有 commit/push/merge 权限）；
- 与 [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md) 中结构化 envelope 匹配的 `outputSchema`。

子 agent 收到完整的分发包（run_id、stage、objective、input artifacts、baseline、允许的操作、禁止的操作、acceptance criteria、待解决的问题、required evidence）。它只返回一个 envelope。

### Ralph 集成

当 Headsman 需要在已批准的 baseline 内迭代时，runtime 在 [`conductor-ralph`](../../../../.agents/skills/conductor-ralph/SKILL.md) 规则下调用共享的内部 `runRalphWorkflow` runner：`maxRalphRounds > 0`、scope 固定、不通过 gate、每轮 fresh workers。独立的 `ralph` 工具与 Conductor 复用同一 runner，但 Conductor 不向专家暴露该工具。Ralph 循环是 Headsman 的子阶段；当它报告 `complete` 时，Headsman 仍然生成最终的 `ImplementationReport`，然后 runtime 路由到 Auditor。

### Arbiter 与 closeout

Gate G 是 The Arbiter。Runtime 加载 [`07-the-arbiter.md`](../../../../.agents/conductor/roles/07-the-arbiter.md) 作为子 agent persona，传递完整的 gate 历史和 delivery package，并要求返回带有 `GO` 或 `NO-GO` 的 `DecisionRecord`。在 `GO` 时，runtime 进入 closeout stage 并使用 [`conductor-closeout`](../../../../.agents/skills/conductor-closeout/SKILL.md) 记录实际的 release 操作、其授权和 outcome evidence。`GO` 本身不会执行 commit、push、merge 或 deploy；这些需要明确的操作权限。

### 已交付的文件

- `packages/conductor/conductor/src/types.ts`、`state.ts`、`persistence.ts`、`routing.ts`、`run-id.ts`、`drive.ts` — run/gate 词汇、状态机、持久化/恢复、路由、run-id 生成以及分发驱动。
- `packages/conductor/tool-conductor/src/index.ts`、`capability.ts`、`ralph.ts` — 面向模型的 `conductor` 工具、按 stage 的 executor 限制，以及与 `packages/workflow/tool-ralph` 所拥有的共享 Ralph runner 的 Headsman 集成。
- `packages/conductor/conductor-presets/src/index.ts` — 专家角色 skill 元数据。
- `apps/cli/config/agent-presets/conductor/agent.cordis.yml` — 挂载角色 loader（隔离的 `skill-filesystem`）和工具的 preset。
- `.agents/conductor/roles/*.md` 和 `.agents/conductor/templates/*.md` — 七个专家角色文件，以及 run、dispatch、envelope、gate、baseline 和 closeout 的操作模板。
- `scripts/gen-tool-catalog.ts` — 注册 `@deepseek-ai/dsh-tool-conductor`；`docs/tool-catalog.md` 和 `docs/config-catalog.md` 已重新生成。

测试：

- `packages/conductor/conductor/tests/`、`packages/conductor/tool-conductor/tests/`、`packages/conductor/conductor-presets/tests/` — gate 路由、rework 映射、恢复、envelope 验证、能力策略、Ralph 指令和 preset 接线的单元测试。
- `packages/conductor/tool-conductor/tests/integration.spec.ts` — 一个真实组合测试，驱动全部七个专家和一个有界 Ralph worker 作为全新 spawn 子 agent，返回 Arbiter 的 GO 决策。
- `examples/headless-agent/tests/headless.snapshot.ts` — 一个 keyless assembled-app snapshot，证明没有现有 run id 的 closeout authorization 会被拒绝且不会持久化 checkpoint。

### 专家 envelope 的 schema

Runtime 强制执行 [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md) 中描述 envelope 的一个子集：

```ts
interface ExecutionBaseline {
  scopeVersion: string
  planVersion: string
  acceptanceVersion: string
  allowedPaths: string[]
  excludedPaths: string[]
  rollbackReference: string
}

interface SpecialistEnvelope {
  run_id: string
  stage: string
  baseline_ref: string
  source_baseline?: string
  status: 'ready' | 'rework' | 'blocked' | 'failed'
  summary: string
  evidence: Array<{
    kind: 'command' | 'file' | 'test' | 'review' | 'external'
    reference: string
    outcome: string
  }>
  findings: Array<{
    id: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    description: string
    impact: string
  }>
  assumptions: string[]
  blockers: string[]
  artifacts: string[]
  change_requests: Array<{
    target: 'scope' | 'plan' | 'baseline' | 'authority'
    reason: string
    impact: string
  }>
  execution_baseline?: ExecutionBaseline
  recommended_transition: {
    target: 'conductor'
    rationale: string
  }
  confidence: 'low' | 'medium' | 'high'
}
```

缺失或格式错误的 envelope 被视为 `blocked` 结果，而不是静默通过。

## Alternatives considered

### 1. 仅将 Conductor 保留为基于 prompt 的 skill

这是之前仅基于 prompt 的状态。它适用于手动使用，但无法强制执行 gate、状态或能力隔离。因为用户明确要求 runtime 实现，所以拒绝。

### 2. 在 DeepSeek Harness 之外构建独立的 Conductor 编排器

单独的服务或脚本可以通过 ACP 或 SDK 驱动相同的 skill。这样可以避免修改 harness，但会重复 subagent 生命周期、skill 加载、preset 挂载和 session 持久化。它还会使 runtime 更难与 harness 变更保持同步。拒绝，选择复用现有 seams。

### 3. 将 Conductor 纯粹实现为 workflow script

一个大型 JavaScript workflow 可以将状态机编码在 `packages/workflow/tool-workflow/src/index.ts` 中。这适合原型验证，但不利于持久状态、schema 验证和能力策略。它还会将面向用户的 product 概念与通用 workflow 引擎混合。拒绝作为主要路径；仍可为高级用户提供 workflow-script 模板。

### 4. 每个 Conductor 角色一个 preset

不是在一个 Conductor run 中分发到角色文件，而是为 Detective、Strategist 等创建单独的 preset。这更字面地符合原始 Conductor 架构，但增加了 preset 管理负担，并使 gate 路由更难集中。拒绝，选择一个 Conductor preset/tool，按 stage 加载正确的角色文件。

## Consequences

Conductor 现在增加一个高层 policy layer，而不修改通用 workflow script language。这样可复用编排仍留在 `packages/workflow`，但 Conductor tool 必须把每个 stage 转换为可信的 per-run child composition，并维护自己的持久 gate record。

每个 gate checkpoint 都会向父 Session 日志增加一个完整 run snapshot。恢复因此是确定性的且不依赖进程内存，代价是重复序列化 history，并对该 Session 的 Conductor checkpoint 做线性 fold。

可写专家不获得 shell，并且 filesystem write/edit tool 使用规范路径 guard。这使 Conductor policy 在同进程 executor 中得到执行；如果部署以后增加另一种 mutation tool，则在向 Headsman 或 Integrator 暴露之前，必须把该工具及其参数提取加入 policy。

Arbiter GO 与 closeout 被刻意分成两次调用。额外授权往返可防止 gate 决策直接变成 commit、push、merge 或 deployment 操作，外部 actor 仍负责实际操作，Conductor 只记录其证据。

## Verification

- `pnpm run test -t conductor` — 71 个测试通过，覆盖状态机/gate 引擎、Session 日志持久化/恢复、路由/rework、run-id、drive、能力策略、Ralph 集成、preset 接线以及真实组合/closeout 测试。
- `pnpm run typecheck` — 通过（host + client 聚合）。
- `pnpm run test:snapshot -t Conductor` — keyless Conductor closeout-authorization snapshot 通过 assembled one-shot application。
- 真实组合测试启动真实 spawn/workflow 栈，驱动 Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator → Arbiter 作为全新的结构化输出子 agent，持久化 GO checkpoint，并记录显式授权的 record-only closeout。
- `pnpm run doc-sync` 的 28 个 gate 中有 26 个通过，Conductor 表面是干净的。剩余失败来自无关且 untracked 的 connections note 中的断链和缺失 pairing record，以及无关且 untracked 的 `temp/` 树中缺失的双语配对。
- `pnpm run lint` 完成 repository build 后，仅因无关且 untracked 的 `temp/oh-my-openagent-dev` 树缺少 `bun-types` 而失败；repository lint runner 对全部 36 个变更的 TypeScript 文件通过。

## Risks

- **Prompt engineering 风险**：runtime 可以强制执行工具限制和 schema，但模型仍然必须遵循角色指令。如果角色文件过于模糊，runtime 会产生格式正确但决策质量差的 envelope。缓解：保持角色文件简短精确；为代表性 Conductor run 添加 keyless snapshot 测试。
- **Workflow 引擎范围蔓延**：Conductor 可能成为运行多 agent 工作的唯一方式，使通用 workflow 工具显得次要。缓解：保持 workflow 工具通用；Conductor 只是构建在其之上的一个高级产品。
- **状态持久化复杂性**：session-log 事件是持久的，但查询它们以恢复并非无成本。缓解：store 按 `run_id` 从最新 checkpoint 向前扫描；如果 checkpoint 量变得显著，可以用 projection 替代该 fold。
- **能力策略扩展风险**：当前 policy 禁止 shell 并 guard `write`/`edit`，但未来 mutation tool 需要显式 allowlist 和参数感知规则。缓解：stage allowlist 默认拒绝，并要求每个新增 mutation tool 都有 executor-denial 测试。
- **Ralph 双重用途**：如果 runtime 同时提供 Conductor Ralph 路径和独立的 `ralph` 工具，用户可能会混淆。缓解：独立工具仍用于显式的 fresh-agent 迭代；Conductor Ralph 是内部的 Headsman 原语，不作为顶层命令暴露。
