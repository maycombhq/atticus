# 0124. Facts the assistant writes, projected into the catalog; the verifier checks the claim on the line (C1 additive, C4, C5)

- Status: accepted (decided by the product owner on 2026-10-24; ADR text pending review)
- Date: 2026-10-24
- Amends: ADR 0074 (steps 1 to 3: the assistant reads first by default; the built-in readers become the optional cross-check; no scanner is generated), ADR 0080 (plugins stay as the escape hatch, not the path)
- Builds on: ADR 0074 (results per commit, a changed file invalidates only what cites it), 0082 (scan verify), 0089 (spec check's claim-on-line), 0103 (quotes forgiven at the ends), 0112 (a model limit every step honours), 0118 (the model searches the code), 0122 (files live in the metarepo)
- Design: "Atticus 2 — AI Reads, Code Verifies" (the product owner's design doc of 2026-10-24, reviewed by a separate session against this repo)

## Context

The built-in readers score 58% precision and 32% recall on the 22-repo public bench, 86% and 58% with the AI's scan settings and client base URLs (`bench/README.md`). Five layers patch the same problem (readers, dialect rules, framework models, repo types, scan settings, plus sandboxed plugins), and every new repo shape still needed an Atticus developer. ADR 0074 decided the direction: the AI reads, deterministic code verifies. This ADR fixes the shape of that, after a review found two faults in the first draft of the design:

1. Replacing catalog C1 (33 record kinds) with a six-kind schema would break every consumer of C1 (the index, the critic's checks, the planner's stages, the API, the app, the editors, the bench scorer) before anything new worked.
2. Having the assistant write a scanner, golden-tested against the facts it had just produced, is circular (it proves the scanner reproduces the assistant, not that the assistant was right), adds a third thing to be wrong, and commits assistant-written executable code to a metarepo on a laptop under a `vm` that is not a security boundary (ADR 0080).

## Decision

### 1. A facts file is the assistant's input format, not a new contract

The assistant reads a repo and writes **facts**: one JSON line each, in six kinds plus flows, every one with a citation.

| Kind     | States                                                               | Claim fields                                                                                     |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `entry`  | Something the repo answers to                                        | `method` and `path`, or `topic`, or `schedule`, or `screen` and `action`; `handler`              |
| `call`   | Something the repo reaches out to                                    | `method` and `path`, or `topic`; `host` or `base`; `from` (an entry id)                          |
| `store`  | A table, collection, bucket, queue or cache the code reads or writes | `store`, `name`, `op` (`read`, `write`, `delete`), `under` (an entry id)                         |
| `field`  | A named value crossing a boundary, and where it maps                 | `owner` (an entry, call, store or screen id), `name`, `type`, `mappedTo`                         |
| `deploy` | How and where the code runs                                          | `runtime`, `cloud`, `resourceType`, `resourceName`, `region`, `pipeline`                         |
| `config` | An external name the code depends on                                 | `key`, `value` or `source` (host, base URL, flag, secret name; a secret's value is never a fact) |
| `flow`   | An entry followed in order through calls and stores                  | `entry`, `steps` (fact ids), `outcome`                                                           |

Every fact carries `id` (a stable hash of kind and claim), `repo`, `commit`, `cite` (`file`, `line`, `value`, `quote`), `verified` (`line`, `sample`, `person` or `none`), `by` (`assistant`, `reader` or `person`) and `conf` (`declared` or `inferred`). The schema is zod in `packages/core/src/schema/facts.ts`, exported as JSON Schema beside C1's. A fact without a citation is not a fact; it is a question.

**Projection.** `projectFacts` in `packages/core` turns verified facts deterministically into C1 records: `entry` into `Endpoint` (or a `Capability` trigger for screens and schedules), `call` into `Interface` with its caller, `store` into `DataStore` access and `Table`, `field` into `Column`, `Schema` field or `FieldMapping`, `deploy` into `Deployment`, `config` into `Setting`, `flow` into `Flow`, and the repo's modules into `Component`. Every projected record keeps the fact's citation as its evidence and `by: assistant` as its source. Nothing downstream of C1 changes; rule 1 is met by this additive ADR with no schema bump.

### 2. The verifier checks the claim on the line

`packages/verify` is the deterministic layer. It never reads code to find facts; it checks the facts it is given.

| Check                            | How                                                                                                                                                                                                                                            | On failure                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| The file exists at the commit    | `git cat-file` on the base clone                                                                                                                                                                                                               | Rejected: `no-file`                                   |
| The claimed value is on the line | `cite.value` (the route, topic, table, field, host or key) appears on `cite.line` or within one line either side, the `spec check` logic of ADR 0089, case-insensitively, with path parameters normalised                                      | Rejected: `value-not-on-line`                         |
| The quote matches                | After normalisation: whitespace folded, CRLF to LF, end punctuation and quote marks forgiven (ADR 0103), capped at 200 characters; a quote from a binary, notebook (`.ipynb`), or minified file (a line over 1,000 characters) is not required | Rejected: `quote-mismatch`                            |
| References resolve               | `from`, `under`, `owner`, `steps` name facts in the same file                                                                                                                                                                                  | Rejected: `dangling-ref`                              |
| No secret in a quote             | Config quotes are redacted by pattern (`password`, `secret`, `token`, `key=` followed by a value, private-key headers); quotes from paths on a deny-list (`.env*`, `*.pem`, `*.key`, `secrets/**`, `**/credentials*`) are refused              | Rejected: `secret-path`; or the quote stored redacted |
| Determinism                      | Facts sorted by id and written canonically; the same commit, the same facts file and the same answers give the same bytes                                                                                                                      | A diff on an unchanged commit is a bug                |

What the verifier proves: every fact rests on a real line that names the thing claimed. What it cannot prove: that the assistant understood the line. Precision comes from the assistant and is measured on the bench; the verifier blocks fabricated and misplaced citations.

**Coverage** is reported, not trusted: files the assistant cited, plus files it read through Atticus-routed tool calls (ADR 0118's `atticus context call`), count as read; every other source file is `unknown`, never "excused" on the assistant's word. Generated code committed to a repo is excluded by a rule the assistant proposes and a person accepts once (`org-pack/scan/<repo>.yaml`, ADR 0075).

### 3. The readers become the cross-check; no scanner is generated

The built-in readers stay in the build, as ADR 0074 already said: an optional fast path, and a cross-check where agreement confirms a fact and disagreement is a finding. They also stay because the `outline` tool (ADR 0118) and `namesInCode` use their parsers. Dialect rules, framework models, repo types and scan settings stop being the path to accuracy. The assistant does not write scanners; ADR 0080's reviewed, sandboxed plugins remain available to a team that wants one. Rescans invalidate only the facts that cite changed files and re-read those files (ADR 0074).

### 4. Three assistant tiers, chosen at init

Organisations sit on one spectrum of assistant capability, and Atticus works at every point of it without being told:

1. **Agentic.** The assistant opens files and runs commands itself (Claude Code, Cursor, Copilot agent mode with the generated prompt files). A map read is one session.
2. **Chat with a token limit and no file tools** (Copilot Chat through `vscode.lm`, about 8,600 tokens of room on GPT-4o mini, ADR 0112). The read runs as hand-off batches: Atticus slices the repo into file batches that fit the limit, hands each as a prompt, verifies each answer as it comes back, and continues until coverage is complete, as the knowledge scan does with `--batch-tokens`.
3. **Copy-paste only** (IntelliJ with Copilot, a web chat). The same batches as copy-ready prompts with a paste-back box.

A capability probe at `atticus init` (can the assistant open a named file on request, what is its token limit, can it write a file back) picks the tier and tells the person what the first read will cost in prompts and time. Every organisation gets the same product; only the speed of the first read differs, and that speed is measured per tier on the bench.

### 5. One home for the map

In a single repo the map lives in `.atticus/` (adopt in place, ADR 0038); in an estate it lives in the metarepo (ADR 0122). Nothing else is written into a product repo. `map.md`, `flows/`, `contracts/` (OpenAPI by default; a TypeSpec file is accepted as the authored target contract) and `questions/` are rendered there and reviewed as a PR.

### 6. The measure comes before the bar

No accuracy bar is set before one measured run of the assistant reading bench batch 1 (six repos) with the verifier on, recorded in `bench/README.md` with the model cost per repo. Today's references score serves, calls, stores and deploys; fields and config are added to five repos' references first so every kind is measured. The working targets are recall 85% and precision 95% on facts and 80% of reference flow steps in order; they move only with numbers.

## Consequences

- Everything built on C1 keeps working while the map's source changes from readers to the assistant.
- The deterministic layer shrinks to what code can prove completely: anchoring, references, redaction, coverage, determinism.
- A team never waits for an Atticus release to read a new repo shape; the assistant reads it, and a correction is a person-verified fact.
- CLAUDE.md rule 4 stands; rule 1 gains the facts schema as an additive contract. `README.md` no longer says scans never call a model.
- `docs/build-status.md`: I1 is done (decided here), groups C and D are superseded, group I's thirteen items are replaced by the Phase A tickets of the design.
- Open for the product owner: whether to publish the package (the `npx` path needs a public repo, decisions-pending 1); the legal sign-off on the embedding model stays owed and the model leaves the default bundle.
