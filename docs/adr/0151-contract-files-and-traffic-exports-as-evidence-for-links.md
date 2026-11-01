# 0151. Contract files and traffic exports as evidence for links

- Status: accepted (J4's redaction rules decided by the product owner; the rest pending review)
- Date: 2026-11-01
- Builds on: ADR 0124 (facts and the estate join, addenda C-join, A-gateway, A-gateway2), 0130 (R1's OpenAPI reader `readOpenApiDocument`), 0135 (how a link was joined, as an Interface's flags), 0143 (exposure findings in the verify report); plan items J3 and J4

## Context

The join makes every link from cited code at both ends. Two kinds of file outside the code say something about those links, and neither was read:

- **Contract files** a consumer keeps: Pact files (consumer-driven contracts, spec v2, v3 and v4), and the OpenAPI spec of an API it calls, checked into the consumer's repo. Each names a request the consumer makes, and a Pact names the provider too.
- **Traffic exports**: a gateway's analytics export (CSV or JSON) or an API catalogue's usage export. They say which app called which route how often, so they show a link used, a link nobody used, and traffic no link carries. They also hold client ids, API keys, IP addresses, user agents, query strings with tokens and request bodies.

## Decision

### 1. Contract files (J3)

`atticus verify <repo> --write` reads the repo's checkout, at the facts' commit, for contract files, as text and JSON whatever the language: a `.json` file under a path that says `pact` whose root has `consumer.name`, `provider.name` and `interactions` (an HTTP interaction's method and path, at the line of its path; message interactions are skipped), and a file named `openapi` or `swagger` that `readOpenApiDocument` reads, unless one of the repo's own REST entries serves one of its operations (then it is the repo's own spec, which R1 reads). Nothing is run or fetched.

What it finds is kept beside the repo's facts as the companion `<repo>.contracts.yaml` (in `FACTS_COMPANIONS`): schema 1, the repo, the commit and the entries (format, file, line, consumer, provider, server URLs for OpenAPI, method, path). A repo with none has no companion. What is kept is a request's shape, never its example values: a path loses its query string, fragment and matrix params (`;jsessionid=...`) and has every segment that isn't a version, a route parameter or a plain lower-case word of at most 20 characters written as `{id}` (`safePathOf`, the rule a traffic base path follows); a server URL loses its user info (`user:pass@`), query string and fragment. A contract file whose entries hold a word the metarepo's `.denylist` names is left out whole, and the write says which file (never the word). Every later write of any repo reads every repo's companion, so the result never depends on which checkouts are on the machine or which repo was written last.

Each entry is matched against the whole estate's join (`linkEvidenceOf`, `core/src/link-evidence.ts`): the joins from the consumer (the component or repo the Pact's consumer names, else the repo's components) whose method agrees and whose call path, first gateway route path or callee path the request's path matches (`routeScore`: a concrete `/accounts/ACC-1` matches `/accounts/{id}`; the best match only). The provider is the component or repo the Pact's provider names, or, for OpenAPI, the component whose manifest host is a server URL's host, else the one `info.title` names.

- A matched link that reaches the provider (its callee, or a gateway it passes) gets the flag `confirmed-by-contract` and an evidence entry `source: spec, side: caller, extractor: atticus-contract@1` citing the contract file's line in the consumer's repo at its commit.
- A matched link to another component: the finding `provider-differs`, and the flag `contract-disagrees` on the link (a gap, as the guesses are).
- No link matched: the finding `no-link` for a Pact interaction. A consumer-side OpenAPI operation with no link is not a finding: a client spec lists operations the consumer may never call.
- A Pact provider that is no component or repo of the estate: the finding `unknown-provider`, with the links the request matched. An OpenAPI spec naming no provider of the estate confirms nothing and says nothing.

### 2. Traffic exports (J4), redacted at import

Decided by the product owner: build it, with the redaction at import, enforced in code with tests.

`atticus intake traffic <file> --source apigee|catalog [--from YYYY-MM-DD --to YYYY-MM-DD]` reads a FILE, never a live connection. The columns each source names are configuration in `ingestors/src/traffic-formats.ts` (`TRAFFIC_SOURCES`; a new source is a new entry). The import (`intake/src/traffic.ts`, `aggregateTraffic`):

- keeps only aggregate counts per (caller app as the export names it, method, path template, proxy, base path) over a day range. Raw rows are never stored. Every other column is dropped by not being read: client ids, API keys, IPs, user agents, full URIs, bodies, whatever they are called. The query string is cut off.
- keeps a path only as the estate's route template it matches (the paths of every repo's verified REST entries and calls). A path no template matches is written as the longest template its start matches followed by `/**` (`/accounts/{id}/**`), or, matching none, dropped and counted (`unmatched`). No segment of a request is ever written, however it looks: the guarantee is structural, not a pattern for every kind of id. Matrix params are cut with the query string; a base path keeps only its safe segments (a version, a route parameter, a plain lower-case word of at most 20 characters; any other is `{id}`).
- keeps an app name only when it is a repo, component or module id of the estate, or an app (or component) a reviewer named a component for in an aggregate on file. Any other name, an IP, an email or a person's name alike, is written as the label `app-<the first 8 hex of its SHA-256>`, stable across imports so its counts still group and a reviewer can name its component.
- drops a proxy that looks like an IP (v4, or v6 in any form: anything with `::`, or hex groups joined by two colons or more), an email (with or without a top-level domain), a JWT, a UUID, a long hex string or a long opaque key.
- refuses, and writes nothing, when the file doesn't read as a CSV with a header or a JSON list of rows (or `{rows|data|records|items: [...]}`) with an app, a method and a path column; when it has no date column and no `--from`/`--to`; when no row is a request in the range to a route of the estate; or when the aggregate it would write fails a check: a value of a dropped column or a query string in it, an IP (v4 or v6), email, long hex or token-looking string in it, or a word the metarepo's `.denylist` (SHA-256 hashes, the format of `scripts/check-denylist.mjs`) names. A refusal is said without the value.

The aggregate goes to `evidence/traffic/<source>-<from>-<to>.yaml` (`.atticus/evidence/` when adopted; `evidenceDirOf`), with the export's SHA-256 so a reviewer can tell which file it came from. A person reviews it in a pull request; where an app's name is no component, they add `component: <id>` to its row.

On every write, each row is matched as a contract entry is, from the app's component: a matched link gets the flag `seen-in-traffic` and an evidence entry `source: export, extractor: atticus-traffic@1` citing the aggregate's row (whose line holds the count; the file holds the range). C1's evidence has no count field, and none is added: the row the evidence cites is the count. The verify report lists each link seen with its count and range. Findings: `missed-link` (traffic no link carries: a call the facts don't have), `unknown-app` (a person names its component in the row), and `unseen-link`: a link the export covers that no row used over the range, possibly dead or wrongly joined. An export covers a link through a gateway route whose proxy or base path it has rows for; an export naming neither covers the links into a component some of its traffic reached.

### 3. Evidence never raises a guess

A contract or traffic adds evidence and a flag; it never changes an Interface's confidence. A link the join guessed (`inferred`, `joined-by-path` and the other guess flags) stays inferred when a Pact or traffic bears it out: neither names the callee in the code, and a consumer's Pact can be as stale as its reader's guess. It is shown beside the guess, so a person settling the question has it. `confirmed-by-contract` and `seen-in-traffic` are not gaps (`LINK_EVIDENCE_NOT_GAPS`, read where `JOIN_HOW_FLAGS` is); `contract-disagrees` is.

### 4. Stable whatever is written first

Every write takes the last write's marks off first (`stripLinkEvidence`: the three flags, and evidence whose `extractor` is one of the two), before it decides what is the repo's own, so a mark never keeps a record alive, then marks again from the companions and aggregates on file against the whole estate's join. The same facts, answers and evidence files give the same catalog in any order, and removing a file takes its marks off at the next write.

### 5. Where it is said

`atticus verify <repo> --write` prints a `Contracts:` and a `Traffic:` line with counts and the first five findings about the repo (its own contract files, its links and its components' traffic; every one with `--verbose`), and writes them under `contracts` and `traffic` in `<repo>.verify.yaml`. An app named like no component belongs to no repo yet, so every write counts it and every verify report lists it under `traffic.unknownApps`.

## Consequences

- No contract change: `flags` on Interface and the `spec` and `export` evidence sources already exist in C1; the facts schema is unchanged. The companion and the aggregate are files of their own, schema 1, with zod schemas in `core/src/link-evidence.ts`.
- The surface census counts one more command (`intake traffic`).
- Matching is by method and path, so two links from the same consumer serving the same path through different hosts are both marked; the evidence entry names the file and line, so a reviewer can tell.
- Not done: gRPC, SOAP and message contracts (Pact message interactions, AsyncAPI); marking GatewayRoutes, not only Interfaces; showing the flags and findings in the app (the Interface's flags and evidence are in the catalog the app reads; a view of their own is later work).
