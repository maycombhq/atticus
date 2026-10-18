# 0019. Diagrams, aliases and reconcile

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/reconcile` reads draw.io diagrams, resolves the names on them to catalog ids, and compares what the diagram says with what the code says. Code wins: reconcile never changes a fact read from code; every difference becomes an item for a person.

**Reading draw.io.** Plain and compressed pages (deflate + base64), several pages per file, `<object>`/`<UserObject>` wrappers, HTML labels, labels held in an edge's child cells, and edges attached to shapes inside a box (they belong to the nearest labelled box; group containers don't count). An edge label is read as an optional pattern code (`S.GW.SOR`), then `METHOD /path` or a topic. Legend comes from the style (`legend=new|modify|retire`) or from a bracketed marker in the text using the profile's legend words (`[New]`, `(Changed)`). Edges with a missing end are reported, not guessed. The reader is golden-tested against `fixtures/forge/expected/inputs.yaml`. As a C4 ingestor (`drawioIngestor`) a diagram becomes a `SourceDocument` record (`docType: diagram`, sha-256 hash).

**Aliases**, in this order: a person's decision (a `CuratedDecision` with `action: alias` in `catalog/curated`); the name made a slug is a component or system id ("Portal BFF" → `portal-bff`); the profile names it as a system or system alias, and a system with one component resolves to that component ("Ledger Platform" → `ledger` → `ledger-api`). A profile match is used but reported as `alias-needed` until a person confirms it with `atticus alias "<name>" <id>`, which writes the curated decision. Anything else is unresolved, with similar ids offered.

**Matching edges.** A drawn edge matches the interfaces between the same ends (a system end stands for its components) with the same method and path (the gateway route's base path may prefix the drawn path) or the same topic; an edge with neither matches every interface between its ends.

**Items.** `alias-needed`, `unknown-box`, `pattern-mismatch` (the drawn pattern's via, sync or target boundary disagree with the interface), `pattern-differs` (drawn and inferred codes differ), `unknown-pattern` (with the nearest known code), `drawn-call-reads-database` (a diagram-only call explained by the caller reading the callee's tables, naming the data-access pattern), `direction-differs`, `diagram-only`, `code-only` (an interface or cross-component table access touching boxes on the diagram but not drawn) and `planned` (legend new, modify or retire). Each has a stable id (type + cell or record), the diagram file, page, cell and line, the records it is about, and a suggested next step; for curation the suggestion is the `CuratedDecision` a person would confirm. Items are a report, not a stored contract: triage (M2) turns them into decisions and change work.

**Command.** `atticus reconcile [diagram...]` (default: every `.drawio` under `inputs/diagrams`) prints the items or `--json`, and exits 1 when there is anything to resolve.

## Consequences

Reconciling the Forge diagram with a fresh scan finds the six seeded reconcile discrepancies (d01–d06) and one more true item, the unknown pattern code that the critic must also catch (d07), and nothing else.
