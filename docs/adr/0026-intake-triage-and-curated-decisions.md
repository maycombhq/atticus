# 0026. Intake, triage and curated decisions

- Status: accepted
- Date: 2026-10-18

## Decision

Intake takes in anything under `inputs/` (`atticus intake add` copies files into `inputs/inbox/`) with no sorting. It classifies each file from its content, dedupes by sha-256, orders versions (spec version, then file-name version, then date) into `supersededBy` chains, and links files to systems through the alias table. Partner specs are read with the same OpenAPI logic as the repo extractor, AsyncAPI channels become topics, payload samples become inferred Schemas with values discarded, and other files go to the C4 ingestors (ADR 0022). Confidence is set centrally by input type: a published spec is `verified` for its own system; anything read from a document is `inferred` at most, so an ingestor can't overclaim. Each file becomes a `SourceDocument`.

`scanEstate` runs intake after the code scan and merges its records after the code's, so code always wins (merge keeps the first value). Wiki folders declared in `sources.yaml` are left to the knowledge sources (ADR 0021).

What intake can't settle becomes a triage item (conflict, unknown name, alias needed, image edges, unclear version, diagram gap, planned) whose options are ready-made `CuratedDecision` drafts. `atticus triage decide` writes the chosen draft to `catalog/curated`, and `applyCurated` replays curated decisions over the merged catalog on every scan: alias, assert, suppress, resolve-conflict, classify. A suppress scoped to a diagram or triage item only hides the item.

## Consequences

The vendor's partner spec closes the last M1 gap: a scan of Forge now matches `expected/scan.yaml` field for field. People decide every conflict; documents never overwrite code. Candidate additive C1 fields: `SourceDocument.systems`.
