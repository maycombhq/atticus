# 0156. A change's impact up the chain, a change that collides with an open seed, and a vendor's headers and error responses

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0144 (a change's impact, V1), 0146 (a repo's starting spec, seeded), 0142 (a prototype compared further), 0130 (a vendor's two versions compared), 0140 (guessed links), 0124 addendum J-guess (the join's guess flags), 0024 (the local API, C4)

## Context

Three gaps were left in beta.10's work:

- `changeImpact` (ADR 0144) listed only the direct callers of what a change breaks. A caller that breaks usually breaks the callers of its own entries too, and those teams heard nothing.
- A seed left open while a change on the same flow reached its stories stage made the change write ADDED for the flow (ADR 0146, Consequences); archiving both fails on a requirement added twice. Nothing said so until the archive failed.
- The vendor spec reader didn't read response headers (ADR 0142, Consequences), and the vendor diff didn't compare error responses between versions, though the reader already listed their statuses.

## Decision

### 1. Up the chain (V1)

`changeImpact` walks up from each direct caller of each item:

- **Whose entries.** A caller's entries that lead to the call are the triggers of its spec flows that make it, when it has some; otherwise every entry it has, since the map doesn't say which one leads there.
- **Who calls them.** The `from` of each catalog Interface to one of those entries (by its Endpoint, or to the component when the Interface names no Endpoint and every entry counts), with the gateway route it goes through; the components of spec flows whose call-out or publish names one; and the caller a trigger of the component's own flows names.
- **Hop by hop.** Each hop records its depth (2 for a caller of a direct caller), the callers it calls through (`via`), the entries it calls, its Interfaces, spec flows, routes, cited caller lines and owner (`ownerOfQuestion`, as for a direct caller). The walk goes on until no new caller turns up or `MAX_CHAIN_DEPTH` (5, a direct caller being 1); `capped` says the cap stopped it with callers still above. A component already on the chain (the entry's own, a direct caller, an earlier hop) isn't walked again, so a cycle stops.
- **Guessed links.** A hop breaks only when one of its own links is sure (not an `inferred` Interface flagged with one of core's `JOIN_GUESS_FLAGS`, or a spec flow names the call) to a caller that surely breaks. Otherwise it may break: `guessed` is its own link's flag, or the flag further down it rests on, with `restsOn` naming that component. `upstream` counts the hops that break and those that may, apart from the direct `breaks` and `mayBreak`, which are unchanged.

The hops' teams join `owners`. `atticus change impact` prints each hop under its item, indented by depth, as "Breaks via `<caller>` (`<entries>`)" or "May break via … (rests on …)"; the Architecture tab's **What this change breaks** has an **Up the chain** table with a **Calls** column. It stays computed from the catalog and the specs, not the facts join, for the reason ADR 0144 gives.

### 2. A change that adds a flow an open seed adds (V2)

`seedCollisions` (planner, files only) reads the open seeds (`openspec/changes/seed-<repo>/` with its `.openspec.yaml`; `atticus spec accept` archives a seed, so an accepted one has left this folder) and each change's `specs/<capability>/spec.md`. A capability whose file has `## ADDED Requirements` adds the flows its Purpose (`Behaviour of flow …`) and its requirements' `Flow:` lines name. A change collides with a seed when both add a flow, or the same capability. It is said, with the remedy (accept the seed with `atticus spec accept <repo>`, then run the change's stories stage again so it writes MODIFIED):

- by the stories stage, as a note after it writes;
- by `atticus spec seed`, for each change that already adds one of the seed's flows (`collisions` in `--json`);
- by `atticus next`, whose first step for that change is a person's `accept-seed` (`atticus spec accept <repo>`).

The critic is left out: its rules read one change's own files, and a check reading another change's folder would need a new rule in the constitution and the estate in its context. The stories stage's note and `atticus next` reach the same people earlier.

### 3. A vendor's response headers and error responses (V3)

- **Response headers.** `readVendorSpec` reads the headers a success response lists (OpenAPI 3's header objects, `$ref`s followed, with `schema` and `required`, false when absent; Swagger 2's, whose type is on the header and which have no `required`) as response fields `in: header`, each citing its name's line. The prototype comparison already treats a vendor field `in: header` as a header, so `header-missing` now compares response headers too; the vendor diff compares them as response fields and says "header" for a field `in: header` on either side. They go into the operation's response Schema record as request headers already go into its request Schema.
- **Error responses between versions.** Each error response (4xx, 5xx) also carries the fields of its body. `diffVendorSpecs` adds `error-added` (breaking: a caller must handle the new status), `error-removed` (additive) and `error-schema` (each body field of an error in both versions compared by the response rules, said with its status: "POST /charges (its 402 response): …"). Each change carries `status`. `atticus intake impact` lists them with the rest, and their reach is the operation's; a call's response fields aren't matched against an error's body.

### 4. Contracts

The local API 2.43.0 (C4, additive): a change impact item's `chain` and `capped`, and the impact's `upstream`. C1, C3, C6 and the facts file are unchanged. `VendorChange` (intake) gains kinds and an optional `status`, and `VendorOperation.errors[]` an optional `fields`; neither is a frozen contract.

## Consequences

- A designer sees who calls the callers a change breaks, and their teams, with guessed links kept apart at every hop.
- A seed left open while a change on its flow is drafted is caught at the stories stage, not at archive.
- A vendor that drops a response header, starts answering a new error or changes an error's body is said to break its callers, with the lines in each version.
- Not done: the walk is from the catalog and the specs, so a caller only the facts join knows isn't on the chain; a hop whose entries the map can't narrow takes every entry of the caller it calls, which can list more than is reached; error responses' headers aren't read; `oneOf` and `anyOf` bodies still aren't compared.
