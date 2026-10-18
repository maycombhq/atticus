# 0017. Merge, identity and the estate scan

- Status: accepted
- Date: 2026-10-18

## Decision

`mergeCatalog` (in `@maycombhq/core`, pure and deterministic) turns the records every extractor and dialect produced for every repo into one catalog. `@maycombhq/scanner` runs the scan over the estate and writes it.

**Identity.**

- Endpoints get a canonical id `<component>.<method>-<last fixed path segment, singular>` (e.g. `ledger-api.get-balance`). If two endpoints of one component would share an id, each gets a short hash suffix of its normalized path. References to provisional ids are rewritten.
- Interfaces keep the C1 id: `if-` + the first 16 hex of sha256(`from|to|METHOD|normalizedPath`). The same call found by two extractors is one record, with both pieces of evidence.
- Components come from the manifest (`component`, else the repo id). A loose end that names a system from the profile but no known component creates an inferred Component of that system.

**Resolving loose ends.**

- `http-call`: through the gateway when the URL's base path matches a gateway route (the hop is caller → route target, `via: gateway`); else by the host's first label as a component or a profile system alias; a relative URL resolves to an endpoint of another component in the caller's own system.
- Events pair publishers and subscribers by topic. Database access becomes table readers and writers.
- An interface is `verified` only when both ends were seen in code or a spec; otherwise `inferred`. Whatever can't be resolved stays an `Unresolved` record with its owner.
- An interface takes `auth` from the callee endpoint when it has none.

**Integration patterns.** A hop with no pattern gets `{ code, source: inferred }` when exactly one non-deprecated pattern in the org pack fits its detection: `via`, `sync`, `targetBoundary` (the callee system's boundary) and the new optional `sameSystem` (caller and callee in one system, e.g. a UI and its own BFF). Zero or several fits leave it empty, for a person to decide. `detection.sameSystem` is an additive, optional C6 field; the org-pack schema version is unchanged.

**Systems** come from the profile, with `owner` and repos from the manifest. A system is `verified` when at least one of its components was seen in code, and its evidence is that component's first piece of evidence; otherwise it is `inferred`, with the evidence of whatever referred to it, or the profile itself.

**The estate scan.** `scanEstate` loads the org pack, runs every dialect's own tests (a failing dialect is skipped and reported, never half-used), scans each base clone with the built-in extractors, plugins and the dialects that apply, then merges. Unchanged repos come from the scan cache (ADR 0010). `atticus scan` writes `catalog/generated/<kind>/<id>.yaml` in canonical form, touching only changed files and removing records that disappeared, and prints the diff: added, removed, changed (with the fields) and evidence-only. It exits 1 when any repo, extractor, dialect or record had a problem. `atticus catalog diff <a> <b>` compares two catalog folders the same way.

**Facts from documents wait for intake.** The vendor's partner spec in `inputs/` is a document, not code. Until intake (M2) brings it in, the vendor endpoint is missing, the vendor call stays `inferred` and the vendor system's confidence follows its references. The M1 test lists exactly these differences from `expected/scan.yaml`.

## Consequences

A scan of `fixtures/forge` finds all seven expected interfaces with their ids, no others, and matches the expected catalog field for field except the facts waiting for intake. Rescans of unchanged repos are served from the cache and write nothing.
