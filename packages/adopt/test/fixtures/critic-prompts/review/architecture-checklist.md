# Architecture review checklist

Use this list when reviewing a design before the architecture board.

## Interfaces

- [ ] Every new interface names an approved integration pattern.
- [ ] Every pattern code used is in the pattern registry.
- [ ] Both ends of every interface exist in the catalog.
- [ ] Each outbound call states its timeout and retry settings.

## Data

- [ ] When the change touches a data store, the data design is filled in.
- [ ] Every new table states how long its rows are kept.
- [ ] Every column holding personal data is classified.
- [ ] Every schema change names the migration that makes it.

## Operability

- [ ] New services have alerts and dashboards defined as code.
- [ ] The design explains how the change is rolled back.
- [ ] Capacity: the design estimates peak requests per second.
