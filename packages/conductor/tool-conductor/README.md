# @deepseek-ai/dsh-tool-conductor

English | [中文](README.zh.md)

The model-facing Conductor tool (`conductor`). It accepts an objective plus optional constraints, acceptance criteria, authority, and a resume id, then mints or resumes a run and drives the gated Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator → Arbiter state machine by spawning one fresh structured-output specialist per stage. It returns the Arbiter's GO/NO-GO decision or a blocker; a GO never commits, pushes, merges, or deploys on its own.

The state machine, gate engine, and run persistence live in [`@deepseek-ai/dsh-conductor`](../conductor/README.md); the specialist role skills come from [`@deepseek-ai/dsh-conductor-presets`](../conductor-presets/README.md).

## Known Limitations and Deferred Work

- **Path-level write scoping not enforced** — the tool applies name-level tool restrictions (read-only Detective/Strategist/Devil's Advocate/Auditor/Arbiter; read+write, no shell for the Integrator), but the Headsman's writes are not yet bounded to the baseline's `allowed_paths` by a filesystem policy. Commit/push/merge are denied by the run's authority and role prompts, not by a name-level tool filter.
- **Ralph requires a mounted tool** — when `maxRalphRounds > 0`, the tool injects the `conductor-ralph` rules and the round bound into the Headsman prompt, but the composition must also mount the `ralph` tool for the child to iterate with it.
- **In-memory persistence only** — runs persist in a per-process store; a durable backend is not yet wired.
