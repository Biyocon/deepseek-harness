# Conductor 软件包

[English](README.md) | 中文

Conductor 软件包基于现有的 workflow、subagent、skill 和 preset 能力，提供受治理的多专家工作。

| 软件包 | 职责 | `ctx` 键 |
|---|---|---|
| [`dsh-conductor`](conductor/README.md) | 持久化运行状态、关卡决策和阶段路由 | `conductor` |
| [`dsh-tool-conductor`](tool-conductor/README.md) | 面向模型的运行启动和恢复工具 | — |
| [`dsh-conductor-presets`](conductor-presets/README.md) | Agent 预设组合和角色文件设置 | — |
