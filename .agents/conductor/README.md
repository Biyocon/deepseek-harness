# Conductor-team

Dette er et sæt tilpassede rolle-instruktioner til en Conductor-session. Hver rollefil bærer frontmatter (`name: conductor-*`, `description`, `disable-model-invocation: true`) og loader derfor som en skill gennem filesystem-skill-provideren, som Conductor-preset'en (`apps/cli/config/agent-presets/conductor/agent.cordis.yml`) monterer; rollekroppen forbliver en manuel prompt. Filerne håndhæver ikke værktøjsrettigheder.

## Ejerskab og routing

Den aktive Codex-agent er **The Conductor** og ejer intake, workflow-state, handoffs, gates, baseline, evidens, rework og eskalering. Brugeren ejer mandatet og autoriserer ændringer. Specialister arbejder kun på en afgrænset arbejdspakke og afleverer altid tilbage til Conductor; ingen specialist sender arbejde direkte til den næste specialist.

Conductor indlæser denne fil og den relevante rollefil ved delegation. Antallet af samtidige specialister følger den faktiske runtime; i den aktuelle session er kapaciteten tre. Parallelle skriveopgaver kræver hver sit eksplicitte `allowed_paths`-område.

## Intake og arbejdspakke

Før første specialist fastlægger Conductor en arbejdspakke med:

```yaml
run_id: unique-id
objective: concrete outcome
scope: included work
allowed_paths: []
baseline: version or commit reference
acceptance_criteria: []
constraints: []
input_artifacts: []
```

Et manglende mandat, uklart scope, manglende baseline eller utilstrækkelige acceptkriterier stopper intake og sendes tilbage til brugeren.

## Handoff

Alle specialistresultater bruger samme envelope og identificerer den version, der blev vurderet:

```yaml
run_id: unique-id
stage: detective|strategist|devils-advocate|headsman|auditor|integrator|arbiter
baseline: version or commit reference
status: ready|rework|blocked|failed
summary: concise result
evidence: []
findings: []
assumptions: []
blockers: []
artifacts: []
recommended_transition: next stage or escalation
confidence: low|medium|high
```

Conductor registrerer separat hver gate `A`–`G` med `decision: pass|rework|escalate|abort`, en kort `basis` og `next_agent`. Rework går til den ansvarlige for fejlen: scope til Detective, plan til Strategist, implementering til Headsman og leverancepakke til Integrator. Ændres Integrator-leverancen efter Auditor, gentages de relevante kontroller på den nye baseline.

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

Arkitekturens designforslag og rapportens rollebeskrivelser findes i [den lokale dybdeanalyse](<../../temp/Conductor-arkitekturen/deep-research-report-Dybdeanalyse af Conductor-arkitekturen, CustomAgents og Ralph-loopet.md>). Projektets stående regler findes i [AGENTS.md](../../AGENTS.md).
