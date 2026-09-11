---
name: conductor-closeout
description: Afslut et Conductor-run efter Arbiterens beslutning med eksplicit myndighed, outcome-verifikation og komplet sporbarhed.
---

# Conductor closeout

Brug denne skill efter Arbiterens DecisionRecord. Den gør forskellen mellem en beslutning om frigivelse og en faktisk, verificeret afslutning eksplicit.

## Modtag beslutningen

Conductor registrerer Arbiterens resultat uden at omskrive det:

```yaml
run_id: CON-YYYY-NNNN
decision: go | no-go
basis: []
evidence_reviewed: []
conditions: []
open_risks: []
required_follow_up: []
```

`no-go` router til den stage, Arbiter eller Conductor har begrundet, eller eskalerer til mandate-ejeren. Luk ikke runnet som succes.

## Ved GO

1. Bekræft at den konkrete release-, commit-, push-, merge-, publish- eller deploy-handling er autoriseret. GO erstatter ikke denne myndighed.
2. Udfør kun de autoriserede handlinger.
3. Verificér det faktiske outcome med frisk evidens på den relevante flade, eksempelvis remote revision, deployment health, publiceret artefakt eller acceptance smoke.
4. Registrér handling, udfald, bevis, resterende risici og ejer af opfølgning.

Hvis myndighed mangler, hold runnet på `awaiting_authorization`; gæt aldrig på brugerens hensigt.

## Afslutningsrecord

```yaml
run_id: CON-YYYY-NNNN
status: closed | awaiting_authorization | rework | escalated | aborted
arbiter_decision: go | no-go
actions_taken: []
outcome_evidence: []
unverified_items: []
open_risks: []
follow_up:
  owner: <navn eller rolle>
  due_condition: <hvad der udløser opfølgning>
traceability:
  mandate: []
  baseline: []
  changes: []
  verification: []
  decision: []
```

Et run er kun `closed`, når den planlagte afslutningshandling, dens passende verifikation og den samlede record er til stede. Rapporter afgrænsede usikkerheder som `unverified_items`; kald ikke arbejdet komplet på deres vegne.
