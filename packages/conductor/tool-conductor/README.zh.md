# @deepseek-ai/dsh-tool-conductor

[English](README.md) | 中文

面向模型的 Conductor 工具（`conductor`）。它接受一个目标以及可选的约束、验收标准、授权和恢复 id，然后铸造或恢复一次运行，并通过为每个阶段生成一个全新的结构化输出专家来驱动 Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator → Arbiter 这一门控状态机。它返回 Arbiter 的 GO/NO-GO 决策或阻塞；GO 本身不会提交、推送、合并或部署。

状态机、gate 引擎和 Session 日志持久化位于 [`@deepseek-ai/dsh-conductor`](../conductor/README.md)；专家角色 skill 来自 [`@deepseek-ai/dsh-conductor-presets`](../conductor-presets/README.md)。每个 stage 都通过现有 workflow engine 运行一个单 agent workflow。Runtime 加载对应角色和 `conductor-specialist`，要求结构化输出，并在 child executor 中同时应用工具名称 allowlist 与参数感知 guard。Headsman 的 `allowed_paths`/`excluded_paths` 检查前会规范化写入目标；Integrator 还仅限 `docs` 与 `.agents/notes`。

当 `maxRalphRounds` 为正时，Headsman 使用相同 child policy 调用共享 Ralph workflow runner，随后仍返回 ImplementationReport，进入 Gate D 和独立 Auditor review。Gate-G GO 以 `awaiting_authorization` 持久化；之后使用相同 `runId` 和明确 owner authorization 的调用，只记录已执行操作、outcome evidence、风险、follow-up 与 traceability。Conductor 本身不执行 release 操作。

## 已知限制与延期工作

- 所选 subagent provider 必须支持结构化输出、工具过滤、可信工具 guard 和逐 child persona；不支持的 provider 会在工具加载时明确失败。
- Closeout 仅记录结果。Commit、push、merge、publish 和 deploy 仍是由外部 owner 控制的操作。
