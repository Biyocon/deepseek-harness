# Execution baseline

Create this record after Gate C. It is immutable until the Conductor explicitly approves a change.

```yaml
scopeVersion: <version>
planVersion: <version>
acceptanceVersion: <version>
allowedPaths: []
excludedPaths: []
rollbackReference: <commit, tag, or artifact>
```

`allowedPaths` and `excludedPaths` must exactly match the owner-authorized run paths; Gate C may not widen them. Headsman may only implement inside this baseline. If work requires a change outside it, stop and return a change request to the Conductor.
