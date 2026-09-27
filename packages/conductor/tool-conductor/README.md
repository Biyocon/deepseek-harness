# @deepseek-ai/dsh-tool-conductor

English | [中文](README.zh.md)

The model-facing Conductor tool (`conductor`). It accepts an objective plus optional constraints, acceptance criteria, authority, and a resume id, then mints or resumes a run and drives the gated Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator → Arbiter state machine by spawning one fresh structured-output specialist per stage. It returns the Arbiter's GO/NO-GO decision or a blocker; a GO never commits, pushes, merges, or deploys on its own.

The state machine, gate engine, and Session-log persistence live in [`@deepseek-ai/dsh-conductor`](../conductor/README.md); the specialist role skills come from [`@deepseek-ai/dsh-conductor-presets`](../conductor-presets/README.md). Every stage runs as a one-agent workflow over the existing workflow engine. The runtime loads the stage role plus `conductor-specialist`, requires structured output, and applies both a name-level tool allowlist and an argument-aware guard in the child executor. Write targets are canonicalized before Headsman `allowed_paths`/`excluded_paths` checks; Integrator is further limited to `docs` and `.agents/notes`.

When `maxRalphRounds` is positive, Headsman calls the shared Ralph workflow runner with the same child policy, then still returns an ImplementationReport for Gate D and independent Auditor review. A Gate-G GO is persisted as `awaiting_authorization`; a later call with the same `runId` and explicit owner authorization records actions already taken, outcome evidence, risks, follow-up, and traceability. Conductor never performs the release action itself.

## Known Limitations and Deferred Work

- The selected subagent provider must support structured output, tool filtering, trusted tool guards, and per-child personas; unsupported providers fail at tool load.
- Closeout is record-only. Commit, push, merge, publish, and deploy remain external owner-controlled operations.
