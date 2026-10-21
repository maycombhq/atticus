# 0072. Scan review: deterministic, then the assistant on the gaps, then deterministic again

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

A scan reads what its readers and rules know. Onboarding (ADR 0059) drafts rules for a repo it reads nothing from, but a repo it mostly reads still leaves gaps: files nothing reads, calls and data access it couldn't resolve, modules with code where it found nothing. Those gaps were listed and left. Some are a rule's to read, some are a vendor's, some are noise, and some are Atticus's own readers getting the code wrong. An AI reading the code can tell which, but an AI writing facts into the catalog would make it neither reproducible nor auditable.

## Decision

`atticus scan review <repo>`:

1. **Gaps, deterministically**, from the last scan: structured files no rule reads (a file the catalog cites is read, whichever rule read it; a top folder with many is one gap), unresolved calls and data access (one gap per component, kind and file, with what the scan saw at each line), and modules with code but no endpoint, call or data access that no other module builds on. `--gaps` stops here.
2. **The assistant's verdict on each gap**, through the AI runtime with the dialect kit as instructions and the code at each gap (with its syntax tree) as data: `rule` (a dialect can read it; the assistant writes it), `reader` (a built-in reader misreads it; a fix for Atticus), `vendor` (an external system a person records), `ignore` (nothing to catalog), or `person`.
3. **Checks, deterministically**: every gap has exactly one verdict from the list; a dialect passes the onboarding checks (valid C2, its own tests pass, records on the repo and none invalid); every gap marked `rule` is read by it. Problems go back for another attempt (`--attempts`, default 3).
4. **Nothing is applied**: the verdicts go to `proposals/reviews/<repo>.md`, the dialect to `proposals/dialects/<name>.yaml`; a person accepts it (`atticus onboard accept`) and the next scan reads with it.

The AI never writes a fact. It improves what the deterministic readers read, and its `reader` verdicts are fixes for Atticus itself. The first review of a real estate found three in the SQL reader, fixed with this ADR: `IS [NOT] DISTINCT FROM` is a comparison, a CTE's name isn't a table, and `information_schema`, `pg_catalog` and `sys` are the database's own catalog.

## Consequences

- A scan's gaps get a decision each, and readable ones become rules a person approved.
- Not yet: verdicts aren't remembered, so the next review lists `ignore`d gaps again; a `vendor` verdict isn't turned into a vendor record; `reader` verdicts are a list for people, not tickets; the side-by-side check (the assistant reading a repo whole and Atticus comparing its list with the catalog) is not built.
