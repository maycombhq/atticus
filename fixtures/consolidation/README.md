# Consolidation fixture (ADR 0193)

An invented Forge estate: three pass-through wrappers (`forge-accounts-wrapper`, `forge-cards-wrapper`,
`forge-limits-wrapper`), each behind its own gateway proxy (`forge-<name>-proxy`), all calling the
Northwind Pay gateway. `strokes.yaml` absorbs the three wrappers into a new `forge-api` service:
their flows move to it with the same entries, they are retired, and each proxy now routes to
`forge-api` at the same entry, so the proxies' contracts don't change.

- `catalog.yaml`: the catalog a scan would give, written by hand.
- `specs/`: today's flows.
- `changes/consolidate-wrappers/`: the change the strokes are drawn into.
- `strokes.yaml`: the strokes file `atticus change sketch --from` reads.

Used by `packages/cli/test/change-sketch-strokes.test.ts`. Nothing here is real.
