# Specialist envelope

Return exactly one structured result per specialist run.

```yaml
run_id: CON-YYYY-NNNN
stage: <role>
baseline_ref: <source or execution baseline actually assessed>
# Ready Detective only when intake source_baseline was null.
source_baseline: <established source reference>
status: ready
# ready | rework | blocked | failed
summary: <concise result>
evidence:
  - kind: command
    reference: <command, file, or identifier>
    outcome: <what the evidence shows>
findings:
  - id: <STAGE>-001
    severity: low
    description: <concrete finding>
    impact: <why it matters>
assumptions: []
blockers: []
artifacts: []
change_requests: []
recommended_transition:
  target: conductor
  rationale: <what the Conductor should decide>
confidence: low
```

`ready` means the specialist work is ready for Conductor review, not that a gate has passed. Omit `source_baseline` except when a ready Detective establishes the source reference missing at intake. A ready Devil's Advocate result at Gate C also includes `execution_baseline` with `scopeVersion`, `planVersion`, `acceptanceVersion`, `allowedPaths`, `excludedPaths`, and `rollbackReference`. Other stages omit that optional field. If evidence is insufficient, return `blocked` or `rework` with a concrete reason.
