# Conductor-skills

Dette katalog er en procesprotokol til agentarbejde. Det er ikke en runtime-integration og kan derfor ikke alene håndhæve værktøjsrettigheder, sessionsisolering eller godkendelser. Den runtime, der starter agenterne, skal håndhæve disse regler.

| Skill | Brug den når | Ejer |
| --- | --- | --- |
| `conductor-orchestration` | et arbejde skal drives gennem flere roller og gates | Conductor |
| `conductor-specialist` | en specialist modtager en afgrænset work package | den pågældende specialist |
| `conductor-ralph` | godkendt implementering kræver flere friske, iterative workers | Headsman under Conductor |
| `conductor-closeout` | Arbiter har truffet GO eller NO-GO, og forløbet skal afsluttes | Conductor |

## Fælles regler

- Emperor giver mandat, prioritet, grænser og eventuel frigivelsesmyndighed.
- Conductor er eneste ejer af workflow-state, dispatch, gates, rework-routing og traceability.
- En specialist sender altid sit resultat tilbage til Conductor, aldrig direkte til den næste specialist.
- `GO` betyder frigivelse er tilladt; det er ikke bevis for, at frigivelsen er gennemført eller verificeret.
- Auditor må ikke rette eller godkende sin egen rettelse. Arbiter må ikke implementere den leverance, der afgøres.
- En skill må ikke påstå, at den har håndhævet runtime-rettigheder. Værktøjsfiltre, skriveadgang og godkendelser verificeres i den konkrete runtime.
