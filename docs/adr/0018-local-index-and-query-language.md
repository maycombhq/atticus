# 0018. The local index, the query language, graph and impact

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/index` keeps a SQLite index of the catalog at `.index/catalog.sqlite` (git-ignored). It is a disposable view (ADR 0003): opening it fingerprints the files in `catalog/generated` and `catalog/curated` (paths, sizes, modification times, index version) and rebuilds when anything differs. A rebuild writes a new file and moves it into place, so a reader never sees half an index. Files that fail C1 are reported and left out.

**Driver.** Node's built-in `node:sqlite` (ADR 0002). It needs no flag from Node 22.13, so the minimum Node version moves from 22.12 to 22.13. Node's one-line experimental warning for it is kept off the terminal. better-sqlite3 stays the documented fallback if `node:sqlite` changes.

**Tables.** `records` (kind, id, status, confidence, label, system, file, stale flag, the record as JSON), `refs` (every reference a record makes, by field) and `evidence` (source, repo, path, line). Reference fields are read from contract C1 itself (`referenceFields` in core: every field typed `Ref`), so a new kind or field needs no change here. The system each record belongs to is worked out at build time: a component's system, an interface's caller's, the owning component's for data, a table's for its columns.

**Query language.** Terms ANDed together: `field:value` (lists match any item; case-insensitive; `,` for alternatives; `*` wildcard; dotted paths for nested fields), `has:` and `missing:`, `refs:` and `refby:` for references, free text over id and label, and `-` to negate. `kind` and `system` are special. It compiles to one parameterised SQL query; field names are checked against a strict pattern and values are always parameters. The reference is `docs/query-language.md`.

**Graph** (the API's `getGraph`): systems, components and interfaces, or the neighbourhood of a component or system within N hops.

**Impact** (the API's `getImpact`) follows dependencies, not every reference: a column or index to its table; a table to its readers and writers; an endpoint, component or system to the calls into it and on to each caller; a publisher or topic to the event interfaces and on to each subscriber; a route to the calls through it; a schema to endpoints using it; settings that target a component; field mappings; foreign keys into a table. Each affected record carries its path from the root, the reason and the owning team. Gaps are questions that would sharpen the answer: calls seen at one end only, systems with no owner, loose ends held by an affected component.

**Commands.** `atticus query`, `atticus impact` and `atticus index rebuild`. Coverage (the API's `getCoverage`) waits for the viewpoint model in M2, where "expected" can be defined per area.

## Consequences

Every read in the CLI, the API server and the UI goes through one index with one notion of "belongs to a system" and one impact rule set. The index for the Forge fixture is a few hundred kilobytes; the M1 exit check measures it on the synthetic estate.
