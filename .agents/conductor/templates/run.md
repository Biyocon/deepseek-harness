# Run initialization

Create or resume this record before Detective. The Conductor owns it; specialists never mutate it directly.

```yaml
run_id: CON-YYYY-NNNN
objective: <concrete outcome>
scope: []
input_artifacts: []
allowed_paths: []
excluded_paths: []
authority:
  owner: <user, emperor, or named owner>
  permitted_actions: [read]
constraints: []
acceptance_criteria: []
budget:
  max_rework_cycles: 3
  max_ralph_rounds: 0
source_baseline: null
execution_baseline: null
current_stage: detective
history: []
specialist_reports: []
```

Use an existing `run_id` only when an unfinished run has the same objective. Resume only from the last documented valid gate.

Before the first dispatch, record the objective, scope, path authority, action authority, budget, and acceptance criteria. Detective may establish an unknown source baseline; the execution baseline remains null until Gate C passes.
