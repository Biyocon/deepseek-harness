# @deepseek-ai/dsh-conductor

English | [中文](README.zh.md)

The Conductor runtime owns run state, gates A–G, defect-class rework routing, source and execution baselines, and explicit closeout records. `SessionConductorRunStore` appends a complete keyed checkpoint to the parent Session log and flushes after each transition; resume accepts only the last documented gate state and rejects terminal or escalated runs.

Specialists return `SpecialistEnvelope` values to Conductor and never choose the next specialist. Gate C installs the immutable execution baseline, Gate G records the Arbiter decision, and a GO remains `awaiting_authorization` until the mandate owner supplies outcome evidence and traceability. The runtime records closeout but performs no commit, push, merge, or deploy action.

## Known Limitations and Deferred Work

- Checkpoints are durable only when the host mounts a persistent Session provider; an in-memory Session retains them only for that process lifetime.
- Conductor records an authorized external closeout action and its evidence but deliberately does not execute release operations.
