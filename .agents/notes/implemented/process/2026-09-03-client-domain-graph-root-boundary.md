# Agent Note: Client domain graph root boundary

Status: implemented

English | [中文](2026-09-03-client-domain-graph-root-boundary.zh.md)

## Problem

`scripts/verify-client-domain-graph.ts` checks that files inside `packages/client/<pkg>/src/client/` only import downward in the layer model: `contract/` is shared, each `<domain>/` is isolated, and only `apply.ts` / `index.ts` may assemble across domains. The old implementation resolved relative import specifiers by walking path segments from the importer's directory-relative position without anchoring the resolution to the actual `src/client/` root. A top-level file importing `../core/detect.ts` therefore looked like a sibling-domain import from a fictitious `core/` domain, even though the real target is outside `src/client/` (typically `src/core/` or `src/types.ts`). Those edges are governed by `verify-module-graph` and the package manifest, not by this gate.

This produced four false positives in `packages/client/ui-input-trigger`: top-level `controller.ts` and `slots.ts` import shared trigger logic from `src/core/` via `../core/...`. The real layering violation is at the package/module-graph level, not inside `src/client/`.

## Decision

The verifier now resolves every relative import with `path.resolve(clientRoot, dirname(importerRel), specifier)` and then `path.relative(clientRoot, resolved)`. If the resolved path starts with `..`, the target is outside the `src/client/` root and the import is ignored by this gate. The existing contract, assembly, and sibling-domain rules stay unchanged, and duplicate occurrences are still reported as separate raw violations.

The gate is implemented in `scripts/verify-client-domain-graph.ts` as exported pure functions plus an ESM `import.meta.main` guard, so the unit spec at `scripts/verify-client-domain-graph.spec.ts` can import and exercise the resolver without running the full gate or calling `process.exit`. The spec covers: top-level `../core` escapes ignored, nested `../bar` siblings reported, top-level `./<domain>` imports reported, multi-level `../../core` escapes ignored, `apply.ts`/`index.tsx` assembly exemption, `contract/` exemption, and preservation of duplicate import occurrences.

The root boundary rule is documented here rather than in the [web client architecture note](../architecture/2026-07-19-gui-web-client-architecture.md), which still owns the directory shape and layer model. This note is a process/tooling clarification that supersedes neither that architecture note nor any package-specific convention.

## Alternatives considered

**Add a package-level allowlist for `ui-input-trigger`.** This would silence the false positives but would hard-code package names into the gate and would break again whenever another package imports shared code from `src/` outside its `src/client/` half. The root-boundary rule fixes the class of errors.

**Move `ui-input-trigger/core/` under `src/client/core/`.** That would place the shared trigger logic inside the client half and satisfy the old, incorrect resolution. It is a larger source move with no architectural benefit and would leave the resolution bug latent for the next package that imports from `src/`.

**Leave the false positives in place.** They train maintainers to ignore the gate output and complicate the GUI pre-push ladder. Removing them keeps the gate signal clean.

## Consequences

The four `ui-input-trigger` false positives disappear, leaving exactly 23 known real residuals inside `packages/client/runtime/` and `packages/client/ui-conversation/` plus one in `packages/client/ui-workspace/`. Those residuals represent genuine sibling-domain or top-level non-assembly imports and remain reported (exit code 1) until they are refactored separately. Any future import that escapes `src/client/` will be ignored by this gate, so package-level coupling must be caught by `verify-module-graph`, the manifest, and code review instead.
