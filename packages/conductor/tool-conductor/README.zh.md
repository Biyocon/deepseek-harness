# @deepseek-ai/dsh-tool-conductor

[English](README.md) | 中文

面向模型的 Conductor 工具（`conductor`）。它接受一个目标以及可选的约束、验收标准、授权和恢复 id，然后铸造或恢复一次运行，并通过为每个阶段生成一个全新的结构化输出专家来驱动 Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator → Arbiter 这一门控状态机。它返回 Arbiter 的 GO/NO-GO 决策或阻塞；GO 本身不会提交、推送、合并或部署。

状态机、门控引擎和运行持久化位于 [`@deepseek-ai/dsh-conductor`](../conductor/README.md)；专家角色技能来自 [`@deepseek-ai/dsh-conductor-presets`](../conductor-presets/README.md)。

## 已知限制和后续工作

- **未强制执行路径级写入范围** — 该工具应用名称级工具限制（Detective/Strategist/Devil's Advocate/Auditor/Arbiter 只读；Integrator 可读可写但不能使用 shell），但 Headsman 的写入尚未由文件系统策略限制到基线的 `allowed_paths`。提交/推送/合并由运行的授权和角色提示拒绝，而非名称级工具过滤器。
- **Ralph 需要已挂载的工具** — 当 `maxRalphRounds > 0` 时，该工具将 `conductor-ralph` 规则和轮次上限注入 Headsman 提示，但组合还必须挂载 `ralph` 工具，子级才能用它迭代。
- **仅内存持久化** — 运行在每进程存储中持久化；尚未接入持久化后端。
