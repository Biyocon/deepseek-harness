# Conductor-team

Dette er et sæt tilpassede rolle-instruktioner til en Conductor-session. Hver rollefil bærer frontmatter (`name: conductor-*`, `description`, `disable-model-invocation: true`) og loader derfor som en skill gennem filesystem-skill-provideren, som Conductor-preset'en (`apps/cli/config/agent-presets/conductor/agent.cordis.yml`) monterer; rollekroppen forbliver en manuel prompt. Filerne håndhæver ikke værktøjsrettigheder.

## Ejerskab og routing

Den aktive Codex-agent er **The Conductor** og ejer intake, workflow-state, handoffs, gates, baseline, evidens, rework og eskalering. Brugeren ejer mandatet og autoriserer ændringer. Specialister arbejder kun på en afgrænset arbejdspakke og afleverer altid tilbage til Conductor; ingen specialist sender arbejde direkte til den næste specialist.

Conductor indlæser den relevante rollefil og specialistkontrakten ved delegation. Parallelle skriveopgaver kræver hver sit eksplicitte `allowed_paths`-område.

## Intake og arbejdspakke

Før første specialist fastlægger Conductor en arbejdspakke med:

```yaml
run_id: unique-id
objective: concrete outcome
scope: included work
allowed_paths: []
excluded_paths: []
source_baseline: version or commit reference, or null until Detective establishes it
execution_baseline: null
acceptance_criteria: []
constraints: []
input_artifacts: []
```

Et manglende mandat, uklart scope eller utilstrækkelige acceptkriterier stopper intake og sendes tilbage til brugeren. En ukendt source-baseline er Detective-arbejde; den senere execution-baseline oprettes først efter Gate C.

## Handoff

Alle specialistresultater bruger samme envelope og identificerer den version, der blev vurderet:

Operative templates:

- [Run initialization](templates/run.md)
- [Specialist dispatch](templates/dispatch.md)
- [Specialist envelope](templates/specialist-envelope.md)
- [Gate decision](templates/gate-decision.md)
- [Execution baseline](templates/baseline.md)
- [Closeout](templates/closeout.md)

```yaml
run_id: unique-id
stage: detective|strategist|devils-advocate|headsman|auditor|integrator|arbiter
baseline_ref: source or execution baseline actually assessed
source_baseline: optional; ready Detective only when intake omitted it
status: ready|rework|blocked|failed
summary: concise result
evidence: []
findings: []
assumptions: []
blockers: []
artifacts: []
change_requests: []
execution_baseline: optional; ready Devil's Advocate only at Gate C
recommended_transition:
  target: conductor
  rationale: what Conductor should evaluate
confidence: low|medium|high
```

Conductor bevarer hvert valideret specialistresultat som en del af run-recorden og sender de tidligere reports til den næste specialist og Arbiter. Conductor registrerer separat hver gate `A`–`G` med `stage`, `decision: pass|rework|escalate|abort`, en kort `basis` og `next_stage`. `ready` bliver kun til et gate-pass, når runnet har acceptkriterier og specialisten leverer konkret evidens. Rework går til den ansvarlige for fejlen: scope til Detective, plan til Strategist, implementering til Headsman og leverancepakke til Integrator.

## Rettigheder og stopregler

Rollefilerne beskriver adfærd, men giver ingen teknisk adgang. Headsman må kun skrive i arbejdspakkens autoriserede scope. Auditor er uafhængig og ændrer ikke produktkode. Integrator må kun samle afgrænsede dokumenter, når arbejdspakken tillader det; ingen rolle committer, merger, pusher eller publicerer uden særskilt autorisation. The Arbiter læser evidens og afgiver `GO` eller `NO-GO`; en `GO` udvider ikke mandatet og udløser ikke release.

## Roller

- [Detective](roles/01-detective.md) — `ClarificationReport`
- [Strategist](roles/02-strategist.md) — `PlanPackage`
- [Devil's Advocate](roles/03-devils-advocate.md) — `ChallengeReport`
- [Headsman](roles/04-headsman.md) — `ImplementationReport`
- [Auditor](roles/05-auditor.md) — `VerificationReport`
- [Integrator](roles/06-integrator.md) — `DeliveryPackage`
- [The Arbiter](roles/07-the-arbiter.md) — `DecisionRecord`

Arkitekturens sporede design og runtimebeslutninger findes i [Conductor Agent Note](../notes/implemented/feature/2026-09-11-conductor-runtime-layer.md). Projektets stående regler findes i [AGENTS.md](../../AGENTS.md).
