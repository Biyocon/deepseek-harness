---
name: conductor-orchestration
description: Kør agentarbejde som en Conductor-ejet, gated state machine med afgrænsede specialist-handoffs, evidens og kontrolleret rework.
---

# Conductor orchestration

Brug denne skill, når et mål kræver flere specialistroller eller en kvalitetssikret overgang fra afklaring til beslutning. Brug den ikke til et lille, selvstændigt spørgsmål, hvor én agent kan levere og verificere resultatet proportionalt.

Denne skill er processtyring, ikke en teknisk adgangskontrol. Bekræft den faktiske runtime-policy, før der lægges vægt på læse-, skrive-, shell- eller godkendelsesgrænser.

## Invarianten

Conductor er processens eneste sandhed for state. Alle resultater returneres til Conductor; ingen specialist vælger selv næste specialist.

```text
specialist -> struktureret resultat -> Conductor -> gate -> dispatch eller rework
```

GO giver aldrig i sig selv lov til commit, push, merge, publicering eller sletning. De kræver stadig den relevante eksplicitte myndighed.

## Initialisér et run

Før Detective køres, opret eller genoptag ét run med:

```yaml
run_id: CON-YYYY-NNNN
objective: <det ønskede resultat>
scope: []
input_artifacts: []
allowed_paths: []
excluded_paths: []
authority:
  owner: <menneske eller Emperor>
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

Brug et eksisterende `run_id`, hvis der findes et uafsluttet run med samme mål. Genoptag kun fra sidste dokumenterede, gyldige gate; opfind ikke usete mellemresultater.

Afklar før dispatch:

1. Hvad er det konkrete mål, omfang og den ønskede leverance?
2. Hvilke ændringer og eksterne handlinger er autoriseret?
3. Hvilken evidens kan vise hvert acceptkriterium?
4. Hvilke specialister er nødvendige ud over kernestrømmen?
5. Hvad stopper eller eskalerer arbejdet?

Manglende svar, der materielt ændrer mål eller myndighed, er en blocker og skal eskaleres til opgavestilleren.

## Kernestrøm og gates

Runtime-kernestrømmen kører alle syv gatede roller. Bevar altid gate-ejerskabet hos Conductor.

| Stage | Rolle | Minimumsleverance | Gate | Passerer til | Typisk rework |
| --- | --- | --- | --- | --- | --- |
| A | Detective | scope- og afklaringsrapport | Scope forstået | Strategist | Detective |
| B | Strategist | plan med acceptkriterier og risici | Plan accepteret | Devil's Advocate | Strategist |
| C | Devil's Advocate | challenge-rapport | Plan modstår review | Headsman | Strategist, derefter nyt review |
| D | Headsman | implementeringsrapport | Godkendt work package udført | Auditor | Headsman |
| E | Auditor | uafhængig verifikationsrapport | Evidens består | Integrator | Headsman, Strategist eller Detective efter fejlklasse |
| F | Integrator | komplet delivery package | Pakke komplet | Arbiter | Integrator eller relevant ejer |
| G | Arbiter | beslutningsrecord | GO eller NO-GO | closeout eller rework | relevant ejer eller eskalering |

Den nuværende runtime har ingen dynamiske ekstra stages. Et manuelt procesforløb kan bruge en afgrænset domænespecialist som input til en kernestage, men resultatet skal stadig returnere til Conductor og kan ikke eje en gate.

## Dispatch-pakke

Giv hver specialist en selvstændig, komplet pakke. Antag ikke, at child-agenten har forælderens kontekst.

```yaml
run_id: CON-YYYY-NNNN
stage: <rolle>
objective: <afgrænset opgave>
scope: []
input_artifacts: []
previous_specialist_reports: []
source_baseline: <version eller null>
execution_baseline: <Gate-C record eller null>
allowed_paths: []
excluded_paths: []
allowed_actions: <stage allowlist intersected with authority, for eksempel [read, write]>
prohibited_actions: [commit, push, merge, release, publish, deploy, shell, <alle handlinger afvist af stage eller authority>]
acceptance_criteria: []
constraints: []
questions_to_resolve: []
required_evidence: []
return_format: conductor-specialist envelope
```

Brug fresh spawn med eksplicit handoff til uafhængige reviews. Brug fork kun, når den afsluttede forældrekontekst er nødvendig og implicit kontekst er en bevidst valgt risiko. En ukendt source-baseline er Detective-arbejde; execution-baselinen oprettes først efter Gate C.

## Baseline og ændringskontrol

Efter Gate C opretter Conductor en immutable execution baseline med scope-, plan- og acceptance-versioner, ejerautoriserede stier, eksklusioner og rollback-reference. Gate C må ikke udvide runnets `allowed_paths` eller fjerne `excluded_paths`.

Hvis Headsman opdager et materielt afvigelsesbehov, stopper arbejdet ved grænsen og returnerer change request til Conductor. Conductor kan godkende en klart autoriseret, lille ændring eller route den til Strategist og Devil's Advocate. Udvid aldrig scope stiltiende.

## Gate-vurdering

Skeln specialistens `status` fra Conductorens beslutning. Registrér altid begge.

```yaml
run_id: CON-YYYY-NNNN
gate: E
stage: auditor
decision: pass
# pass | rework | escalate | abort
basis: []
evidence_reviewed: []
defect_class: null
next_stage: integrator
state_update: <kort, konkret ændring>
```

Et `pass` kræver relevant, frisk evidens mod acceptkriterierne. Manglende evidens er ikke et pass. Brug `rework` for en kendt, afgrænset rettelse; `escalate` når mål, risiko eller myndighed kræver en ejerbeslutning; brug `abort` ved stopbetingelse eller når videre arbejde ikke længere er forsvarligt.

## Traceability og afslutning

Knyt alle væsentlige elementer til `run_id`: mandat, krav, plan, challenge, baseline, changeset, testresultat, delivery package og Arbiter-beslutning. Henvis til konkrete artefakter og kommandooutput frem for fritekstpåstande.

Efter Gate G anvendes `conductor-closeout`. Et run er først afsluttet, når outcome og den krævede efterfølgende verifikation er dokumenteret.
