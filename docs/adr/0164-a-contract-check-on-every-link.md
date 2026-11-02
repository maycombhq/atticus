# 0164. A contract check on every link

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0124 (facts the assistant writes; addenda C-join, A-gateway, A-gateway2), 0125 (a Schema field says whether it is required), 0130 (a vendor's operations), 0142 (enums, headers, errors; another team's spec, O2), 0151 (contract files as evidence, J3), 0149 (the outside systems)

## Context

The join (ADR 0124 C-join) says which entry each call reaches, through which gateways, and lines up the fields that cross by name (`lineage`, `gaps`). It never asked whether the two sides agree on the payload: a gateway's published spec can promise a field the Spring Boot service behind it never returns; a listener can read a field the publisher never sends; two copies of a `.proto` can give one field number to two fields. Plan item F7 asks for that check on every link, and for wrapping (envelopes, gateway reshapes, mappers) to be read from the code, never assumed or configured per organisation.

## Decision

### 1. What is compared

`checkContracts` (core `contract-check.ts`) takes the estate join, every repo's facts, the specs on file and the outside systems' intaken specs, and compares, for every link:

| Link                                                                   | Boundaries                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A REST call joined to an entry                                         | caller → each gateway route's published spec (when its repo has one) → the service; a route with no spec is passed through                         |
| A gateway's forwarding call                                            | checked as a hop of the calls through it (once), and its own Interface named on each finding (`interfaces`)                                        |
| A publish joined to a listener                                         | publisher → listener; publisher → the spec its message type names; listener → the spec it reads by; that spec → the publisher's (protobuf numbers) |
| A listener whose publisher is outside                                  | the intaken spec → the listener                                                                                                                    |
| A call to an outside system matched to an operation (ADR 0130's match) | the call (or a forwarding call's route spec, translated) → the operation                                                                           |

Kinds: `field-missing` (read, never sent or returned), `field-extra` (sent, not taken; or returned and not published, when the sender is a published spec), `field-not-sent` (required, not sent), `field-required` (required on one side only), `field-type` (another type family), `field-number` (a protobuf number given to another name or type), `error-unlisted` (answered, not listed or handled), `error-unanswered` (a published spec lists it, the service never answers it; 401, 403, 429 and 502–504 are a gateway's own and skipped behind one). ADR 0125's rule holds everywhere: a side that lists nothing is unknown, not different. Names compare dotted segment by segment, case, `_`, `-` and `[]` aside; a path that differs only in its prefix matches its one field with the same last segment.

### 2. Wrapping, from the code

All of it is field facts already in the facts file (`mappedTo`, `transform`); nothing is a setting:

- **Envelope**: the wrapper's field (`data`) is a field fact of the side; each field inside it has `mappedTo` it and a `transform` saying envelope (`envelope Response<T>`). The wire name is `data.id`.
- **Mapper** (MapStruct, AutoMapper, a converter): a field `mappedTo` another field of the same owner and side, with a `transform` naming the mapper. Outbound (an entry's response, a call's request or message) the target travels; inbound the source does.
- **Gateway reshape** (AssignMessage, JavaScript, XSL): a field of the route `mappedTo` one of its forwarding call, or the other way, cited on the policy. These are mapping facts, not a payload: the forwarding call's face excludes them.
- **Untraced**: a field with a `transform` and no `mappedTo`. Any difference that touches it is `unconfirmed`, never a mismatch. So is a difference on its counterpart: a field read, sent or required that the other side lacks, where the other side has an untraced field on that payload that matched nothing across the boundary (the converter may have renamed it: `acctBal` written by `BalanceSerializer`, read as `balance`). The finding cites that untraced line, the first by name, preferring one of the same type family.
- **Message type**: a `message` field fact with `transform: message type`, its `name` the type as the code writes it and `type` its full name. It ties a publish or listener to its spec (the listener's repo first, then the publisher's, then the estate, then intake).

The reading rules (`FACT_RULES`) say this in three parts (backend, frontend, protocols; gateway). Repos read before need `atticus map --all --stale` (or a read of the files that hold DTOs, mappers and policies) before their links are compared; until then they are unknown, not different.

### 3. The specs on file

- **A repo's own** (`<repo>.specs.yaml`, a new facts companion, `FACTS_COMPANIONS`): `verify --write` reads the checkout at the facts' commit (`readRepoSpecs`, intake), by content, in any folder: OpenAPI (through `readVendorSpec`), `.proto` (messages, nested, labels, numbers), Avro `.avsc`, JSON Schema, AsyncAPI (each message with its channel). An operation one of the repo's own REST entries serves is `own` (a gateway's published spec, tied to its route); another is a consumer's copy (J3), standing in for a call with no fields. The deny-list applies as for contract files.
- **Intake**: `.proto` and `.avsc` are classified (`protobuf`, `avro`), linked to the system their name or package names, and read into Schema records of that system. An outside system's newest spec is compared, and the one it replaced too: `newFindings` gives what the new spec brings.

### 4. Surfaces

`atticus join contracts [--json]` (and `estate contracts`); `GET /api/contracts` and the page Map › Mismatches (aside, with empty, loading and error states); a link whose calls have findings gets the gaps `contract-mismatch` or `contract-unconfirmed` on the canvas and its findings under each call in Why is this linked?; the Trust tab counts them (`TrustView.contracts`); an outside system's page lists the calls against its newest spec, marking what the spec brought.

The check costs little per ask: `checkContracts` indexes each repo's facts once (by id, field facts by owner, flows by entry and by the call a step names, each entry's or call's payload worked out once), so 40 repos of 2,520 facts and 2,400 links check in a fraction of a second. `contractCheckOf` (CLI) keeps each metarepo's result, with a stamp of the path, size and modification time of every file under facts/, the inputs, the org pack, the questions and the curated catalog; `/api/contracts`, `/api/trust` and `/api/outside` share it, asks at once share one run, and any change to one of those files works it out again. A run that fails isn't kept.

## Contract notes

- **The facts file:** unchanged. Every reading above uses `side`, `name`, `type`, `required`, `mappedTo` and `transform`, which it already has.
- **C1:** schema version 4: a Schema's `format` gains `protobuf`. No other field changes; version-1, -2 and -3 files read as they are and come back as version 4. Migration: `migrateCatalog` rewrites a version-3 file with only the number changed; `atticus upgrade` has the step `catalog-schema-v4`.
- **C4:** local API 2.47.0, additive: `GET /api/contracts` (`ContractsView`), `TrustView.contracts`, `OutsideSystemView.contracts`.
- **New file schema:** `SpecsFile` (`<repo>.specs.yaml`, schema 1), a facts companion like ADR 0151's contracts file.

## Consequences

- A gateway's published spec is held to the Spring Boot payload behind it, through its envelope and its AssignMessage renames, on the bank-shaped fixture (`fixtures/link-estate/contracts/`, an overlay so P1, P3 and J1's pinned figures are unchanged).
- Topics are checked publisher against each listener and against their `.proto`, and a renumbered field is a finding.
- A mapping nobody traced never shows as a mismatch.

**Not done here:** Pact files' bodies aren't read as payloads (only their method and path, as J3 has them); enum values aren't compared on links (the prototype comparison does); `oneOf` bodies and proto `oneof` as alternatives are flattened; the check is computed on demand, not stored in the catalog.
