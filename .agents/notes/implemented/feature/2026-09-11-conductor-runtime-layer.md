# Agent Note: Conductor runtime layer

Status: implemented

English | [中文](2026-09-11-conductor-runtime-layer.zh.md)

## Problem

The Conductor process protocol already exists as four local skills — [`conductor-orchestration`](../../../../.agents/skills/conductor-orchestration/SKILL.md), [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md), [`conductor-ralph`](../../../../.agents/skills/conductor-ralph/SKILL.md), and [`conductor-closeout`](../../../../.agents/skills/conductor-closeout/SKILL.md) — and the seven specialist role files live under [`.agents/conductor/roles/`](../../../../.agents/conductor/README.md). Those assets are enough for disciplined manual or semi-manual agent work, but they are not a runtime. Today nothing in DeepSeek Harness automatically:

- mints or resumes a durable `run_id`;
- routes a specialist result through a gate decision;
- enforces that Detective is read-only while Headsman may write only inside an authorized scope;
- validates the structured envelope a specialist returns;
- records gate history so Arbiter can see every prior decision;
- isolates the Arbiter from the implementer or the Auditor from its own fix.

Without that runtime layer, the skills are a convention that the model may follow, not a guarantee the harness enforces. The gap is becoming visible because users now want to say "run this through Conductor" and have the gates, baseline, and rework happen automatically.

## Decision

Build one Conductor workflow/runtime feature that uses the existing skills and role files as instructions, but implements state, gates, routing, and enforcement inside DeepSeek Harness. The feature has four concrete parts:

1. **A Conductor state machine** (`packages/conductor/conductor`) that owns one run's lifecycle and persists enough state to resume after interruption.
2. **A model-facing Conductor tool** (or a preset-driven command) that starts a run, attaches the right role files as per-child personas, and routes results through gates.
3. **Schema-validated specialist envelopes** and gate records so the runtime can tell a `blocked` Detective from a `ready` Headsman and route rework correctly.
4. **Capability policies** that map each stage to a tool restriction (read-only, write-only inside `allowed_paths`, no commit/push/merge, etc.) enforced by the subagent provider, not only by prompt text.

The feature reuses the existing workflow engine, subagent providers, skill registry, and preset system; it does not replace them.

### Where it lives

The Conductor runtime should be a new package group under `packages/`:

```
packages/conductor/
  conductor/          # run state machine + gate engine
  tool-conductor/     # model-facing tool (or workflow script wrapper)
  conductor-presets/  # optional preset composition for Conductor sessions
```

The proposal keeps Conductor separate from the generic workflow-engine group because Conductor is a user-facing role system, not a workflow primitive.

### Run state

A run is durable state keyed by `run_id`. The minimal record is:

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

The runtime persists this record in the parent session log using existing session events, and/or in a small host-side store keyed by `run_id`. Cold resume reads the latest gate record and restarts from that stage, never from an undocumented state.

### Stage routing

The run advances through the gates in [`conductor-orchestration`](../../../../.agents/skills/conductor-orchestration/SKILL.md):

| Gate | Stage | Passes to | Rework target by defect class |
|------|-------|-----------|-------------------------------|
| A | Detective | Strategist | Detective (scope) |
| B | Strategist | Devil's Advocate | Strategist (plan) |
| C | Devil's Advocate | Headsman | Strategist, then new Devil's Advocate |
| D | Headsman | Auditor | Headsman (implementation) |
| E | Auditor | Integrator | Headsman, Strategist, or Detective by defect class |
| F | Integrator | Arbiter | Integrator or owner |
| G | Arbiter | closeout | relevant owner or escalation |

The Conductor state machine is the only code that decides `nextStage`. A specialist result carries only `recommended_transition: { target: 'conductor', rationale }`; it never names the next specialist.

### Specialist dispatch

Each specialist is a fresh `spawn` subagent with:

- the corresponding role file from [`.agents/conductor/roles/`](../../../../.agents/conductor/README.md) loaded as a per-child persona or injected as a skill body;
- the [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md) skill injected so the child knows the envelope format;
- a tool restriction that matches the stage (read-only for Detective/Auditor/Arbiter; write restricted to `allowed_paths` for Headsman; no commit/push/merge for anyone);
- an `outputSchema` that matches the structured envelope in [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md).

The child receives a complete dispatch package (run_id, stage, objective, input artifacts, baseline, allowed actions, prohibited actions, acceptance criteria, questions to resolve, required evidence). It returns exactly one envelope.

### Ralph integration

When Headsman needs iteration inside an approved baseline, the runtime calls the shared internal `runRalphWorkflow` runner under [`conductor-ralph`](../../../../.agents/skills/conductor-ralph/SKILL.md) rules: `maxRalphRounds > 0`, scope fixed, no gate pass, fresh workers per round. The standalone `ralph` tool and Conductor reuse the same runner, but Conductor does not expose that tool to specialists. The Ralph loop is a sub-phase of Headsman; when it reports `complete`, Headsman still produces the final `ImplementationReport` and the runtime routes to Auditor.

### Arbiter and closeout

Gate G is The Arbiter. The runtime loads [`07-the-arbiter.md`](../../../../.agents/conductor/roles/07-the-arbiter.md) as the child persona, passes the full gate history and delivery package, and requires a `DecisionRecord` with `GO` or `NO-GO`. On `GO`, the runtime moves to the closeout stage and uses [`conductor-closeout`](../../../../.agents/skills/conductor-closeout/SKILL.md) to record the actual release action, its authorization, and outcome evidence. A `GO` does not itself perform a commit, push, merge, or deploy; those require explicit action permissions.

### Files shipped

- `packages/conductor/conductor/src/types.ts`, `state.ts`, `persistence.ts`, `routing.ts`, `run-id.ts`, `drive.ts` — run/gate vocabulary, state machine, persistence/resume, routing, run-id minting, and the dispatch driver.
- `packages/conductor/tool-conductor/src/index.ts`, `capability.ts`, `ralph.ts` — the model-facing `conductor` tool, per-stage executor restrictions, and Headsman integration with the shared Ralph runner owned by `packages/workflow/tool-ralph`.
- `packages/conductor/conductor-presets/src/index.ts` — the specialist role-skill metadata.
- `apps/cli/config/agent-presets/conductor/agent.cordis.yml` — preset that mounts the role loader (an isolated `skill-filesystem`) and the tool.
- `.agents/conductor/roles/*.md` and `.agents/conductor/templates/*.md` — the seven specialist role files and the operational run, dispatch, envelope, gate, baseline, and closeout templates.
- `scripts/gen-tool-catalog.ts` — registers `@deepseek-ai/dsh-tool-conductor`; `docs/tool-catalog.md` and `docs/config-catalog.md` regenerated.

Tests:

- `packages/conductor/conductor/tests/`, `packages/conductor/tool-conductor/tests/`, `packages/conductor/conductor-presets/tests/` — unit tests for gate routing, rework mapping, resume, envelope validation, capability policies, Ralph directive, and preset wiring.
- `packages/conductor/tool-conductor/tests/integration.spec.ts` — a real-composition test that drives all seven specialists plus a bounded Ralph worker as fresh spawn children against a scripted model and returns the Arbiter's GO decision.
- `examples/headless-agent/tests/headless.snapshot.ts` — a keyless assembled-app snapshot that proves closeout authorization without an existing run id is rejected without persisting a checkpoint.

### Schema for the specialist envelope

The runtime enforces a subset of the envelope described in [`conductor-specialist`](../../../../.agents/skills/conductor-specialist/SKILL.md):

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

A missing or malformed envelope is a `blocked` result, not a silent pass.

## Alternatives considered

### 1. Keep Conductor as prompt-only skills

This was the prior prompt-only state. It worked for manual use but could not enforce gates, state, or capability separation. Rejected because the user explicitly asked for a runtime implementation.

### 2. Build a standalone Conductor orchestrator outside DeepSeek Harness

A separate service or script could drive the same skills via the ACP or SDK. That would avoid touching the harness but would duplicate subagent lifecycle, skill loading, preset mounting, and session persistence. It would also make the runtime harder to keep in sync with harness changes. Rejected in favor of reusing the existing seams.

### 3. Implement Conductor purely as a workflow script

A large JavaScript workflow could encode the state machine inside `packages/workflow/tool-workflow/src/index.ts`. That is cheap to prototype but poor at durable state, schema validation, and capability policy. It also mixes a user-facing product concept with the generic workflow engine. Rejected as the primary path; a workflow-script template may still be offered for advanced users.

### 4. One preset per Conductor role

Instead of dispatching to role files inside one Conductor run, create a separate preset for Detective, Strategist, etc. That matches the original Conductor architecture more literally but multiplies preset management and makes gate routing harder to centralize. Rejected in favor of one Conductor preset/tool that loads the right role file per stage.

## Consequences

Conductor now adds a higher-level policy layer without changing the generic workflow script language. That keeps reusable orchestration in `packages/workflow`, but the Conductor tool must translate every stage into a trusted per-run child composition and maintain its own durable gate record.

Every gate checkpoint enlarges the parent Session log with one whole-run snapshot. Resume is deterministic and does not need process memory, at the cost of repeated serialized history and a linear fold over that session's Conductor checkpoints.

Write-capable specialists lose shell access and use canonical path guards on filesystem write/edit tools. This makes the in-process executor enforce the Conductor policy, while deployments that later add another mutation tool must add that tool and its argument extraction to the policy before exposing it to Headsman or Integrator.

Arbiter GO and closeout are deliberately separate calls. The additional authorization round trip prevents a gate decision from becoming a commit, push, merge, or deployment action and leaves the external actor responsible for the action whose evidence Conductor records.

## Verification

- `pnpm run test -t conductor` — 71 tests pass across the state machine/gate engine, session-log persistence/resume, routing/rework, run-id, drive, capability policies, Ralph integration, preset wiring, and the real-composition/closeout test.
- `pnpm run typecheck` — passes (host + client aggregates).
- `pnpm run test:snapshot -t Conductor` — the keyless Conductor closeout-authorization snapshot passes through the assembled one-shot application.
- The real-composition test boots the real spawn/workflow stack, drives Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator → Arbiter as fresh structured-output children, persists the GO checkpoint, and records an explicitly authorized record-only closeout.
- `pnpm run doc-sync` passes 26 of 28 gates and is clean for the Conductor surface. The remaining failures are broken links and a missing pairing record in the unrelated untracked connections note plus missing bilingual pairs inside the unrelated untracked `temp/` trees.
- `pnpm run lint` completes the repository build and then fails only on missing `bun-types` in the unrelated untracked `temp/oh-my-openagent-dev` tree; the repository lint runner passes all 36 changed TypeScript files.

## Risks

- **Prompt engineering risk**: the runtime can enforce tool restrictions and schemas, but the model still has to follow the role instructions. If the role files are too vague, the runtime will produce clean envelopes with poor decisions. Mitigation: keep role files short and precise; add keyless snapshot tests for representative Conductor runs.
- **Scope creep into general workflow engine**: Conductor could become the only way to run multi-agent work, making the generic workflow tool feel second-class. Mitigation: keep the workflow tool general; Conductor is one higher-level product built on top of it.
- **State persistence complexity**: session-log events are durable but querying them for resume is not free. Mitigation: the store scans newest-first by `run_id`; a projection can replace that fold if checkpoint volume becomes material.
- **Capability-policy extension risk**: the current policy denies shell and guards `write`/`edit`, but a future mutation tool would need an explicit allowlist and argument-aware rule. Mitigation: fail closed at the stage allowlist and require an executor-denial test for every added mutation tool.
- **Ralph double-use**: if the runtime offers both a Conductor Ralph path and the standalone `ralph` tool, users may confuse them. Mitigation: the standalone tool remains for explicit fresh-agent iteration; Conductor Ralph is an internal Headsman primitive and is not exposed as a top-level command.
