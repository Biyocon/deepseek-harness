# @deepseek-ai/dsh-conductor

[English](README.md) | 中文

Conductor runtime 拥有 run 状态、A–G gate、按缺陷类别的 rework 路由、source/execution baseline 以及显式 closeout record。`SessionConductorRunStore` 在每次转换后向父 Session 日志追加完整的键控 checkpoint 并执行 flush；恢复只接受最后一个已记录 gate 的状态，并拒绝 terminal 或 escalated run。

专家把 `SpecialistEnvelope` 返回给 Conductor，绝不自行选择下一个专家。Gate C 安装不可变 execution baseline，Gate G 记录 Arbiter 决策；GO 会保持 `awaiting_authorization`，直到 mandate owner 提供 outcome evidence 与 traceability。Runtime 只记录 closeout，不执行 commit、push、merge 或 deploy。

## 已知限制与延期工作

- 只有 host 挂载持久化 Session provider 时，checkpoint 才具备跨进程持久性；内存 Session 只在当前进程生命周期内保留记录。
- Conductor 记录已授权的外部 closeout 操作及其证据，但按设计不执行 release 操作。
