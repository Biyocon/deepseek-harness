# Specialist dispatch

Give every specialist a self-contained package. Assume the child does not inherit parent context.

```yaml
run_id: CON-YYYY-NNNN
stage: <detective|strategist|devils-advocate|headsman|auditor|integrator|arbiter>
objective: <bounded task>
scope: []
input_artifacts: []
previous_specialist_reports: []
source_baseline: <version, commit reference, or null>
execution_baseline: <Gate-C record or null>
allowed_paths: []
excluded_paths: []
allowed_actions: <stage allowlist intersected with authority, for example [read, write]>
prohibited_actions: [commit, push, merge, release, publish, deploy, shell, <every action denied by stage or authority>]
acceptance_criteria: []
constraints: []
questions_to_resolve: []
required_evidence: []
return_format: specialist-envelope
```

Load the matching role file as the child persona and the specialist skill as the envelope contract. Use fresh spawn for every specialist. Never let one specialist send work directly to another; every result returns to the Conductor.
