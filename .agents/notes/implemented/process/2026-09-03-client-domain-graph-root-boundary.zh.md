# Agent Note: 客户端领域图根边界

Status: implemented

[English](2026-09-03-client-domain-graph-root-boundary.md) | 中文

## Problem

`scripts/verify-client-domain-graph.ts` 校验 `packages/client/<pkg>/src/client/` 内的文件只能按层级向下导入：`contract/` 共享，每个 `<domain>/` 互相隔离，只有 `apply.ts` / `index.ts` 可以跨领域组装。旧实现通过从导入文件目录相对位置逐段拼接路径来解析相对导入说明符，但没有把解析锚定到真实的 `src/client/` 根目录。因此，顶层文件导入 `../core/detect.ts` 会被当作来自虚构的 `core/` 领域的兄弟领域导入，而真实目标其实在 `src/client/` 之外（通常是 `src/core/` 或 `src/types.ts`）。这些边应该由 `verify-module-graph` 与包清单来管理，而不是本 gate。

这在 `packages/client/ui-input-trigger` 中产生了四个误报：顶层 `controller.ts` 和 `slots.ts` 通过 `../core/...` 从 `src/core/` 导入共享触发逻辑。真正的层级违规在包/模块图层面，而不在 `src/client/` 内部。

## Decision

校验器现在使用 `path.resolve(clientRoot, dirname(importerRel), specifier)` 再 `path.relative(clientRoot, resolved)` 解析每个相对导入。如果解析后的路径以 `..` 开头，说明目标在 `src/client/` 根之外，本 gate 忽略该导入。原有的 contract、assembly 与兄弟领域规则保持不变，重复的导入出现仍作为原始违规分别报告。

gate 实现在 `scripts/verify-client-domain-graph.ts` 中，以导出纯函数加 ESM `import.meta.main` 守卫，因此 `scripts/verify-client-domain-graph.spec.ts` 中的单元测试可以导入并驱动解析器，而无需运行完整 gate 或调用 `process.exit`。测试覆盖：顶层 `../core` 逃逸忽略、嵌套 `../bar` 兄弟领域报告、顶层 `./<domain>` 导入报告、多级 `../../core` 逃逸忽略、`apply.ts`/`index.tsx` 组装豁免、`contract/` 豁免、重复导入出现保留。

根边界规则记录在本篇，而非 [web client architecture note](../architecture/2026-07-19-gui-web-client-architecture.md) 中；后者仍然持有目录结构与层级模型的权威定义。本篇是流程/工具层面的补充说明，不替代该架构笔记，也不替代任何包级约定。

## Alternatives considered

**为 `ui-input-trigger` 增加包级白名单。** 这会消除误报，但会把包名硬编码进 gate，而且只要其他包从 `src/` 导入其 `src/client/` 半区外的共享代码，问题就会再次出现。根边界规则一次性修正了这类错误。

**将 `ui-input-trigger/core/` 移到 `src/client/core/` 下。** 这样共享触发逻辑会落入 client 半区，从而满足旧的、错误的解析方式。但这属于更大的源码移动，没有架构收益，并且会把解析 bug 留给下一个从 `src/` 导入的包。

**保留误报。** 这会让维护者逐渐忽略 gate 输出，并污染 GUI pre-push 阶梯。清除误报可保持 gate 信号干净。

## Consequences

四个 `ui-input-trigger` 误报消失，剩余 `packages/client/runtime/`、`packages/client/ui-conversation/` 以及 `packages/client/ui-workspace/` 中的 23 个已知真实残差继续被报告（退出码 1），直到它们被单独重构。未来任何逃逸 `src/client/` 的导入都会被本 gate 忽略，因此包级耦合必须由 `verify-module-graph`、清单与代码审查来捕获。
