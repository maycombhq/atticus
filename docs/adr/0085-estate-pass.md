# 0085. The estate pass: flows joined across repos, end-to-end flows and field lineage (C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), 0079 (the Flow record and repo specs)

## Context

A repo's spec (ADR 0079) is made of flows, and a call-out step names where it goes (`to: { component, entry }`). Nothing followed a call-out into the flow the target repo starts, so every flow stopped at its repo's edge. The plan (4.2, Phase 3 items I12 and D11) asks for the estate pass: each repo's call-outs matched to the other repos' triggers, through gateways and topics, so a flow continues from a button click to the database it ends in, with a citation at both ends of every join; and a field followed from a screen to its column.

On the bench, each repo was scanned alone, so the petclinic Angular UI's drafted flows could not name the REST API at all (the assistant said so in the step: "the backend is not in the catalog").

## Decision

### The joins file (new metarepo file, C6 family beside the spec header)

`atticus estate join` reads every repo's spec in the metarepo and the one catalog, and writes `specs/estate.yaml` (`.atticus/specs/estate.yaml` when adopted), schema version 1 (`EstateJoins`):

```yaml
schemaVersion: 1
joinedAt: <ISO time>
repos: [forge-customers, forge-web]
joins:
  - from: { repo, flow, step, evidence: "path:line" } # the caller's step, 1-based
    to: { repo, flow, trigger: <Endpoint id>, evidence: "path:line" } # the callee's trigger
    entry: "<component> <entry>" # what the step names
    interface: <Interface id> # when the catalog has one
    how: interface | endpoint | path
unmatched:
  - from: { repo, flow, step, evidence }
    entry: ...
    reason: no-target | no-flow | no-citation
    trigger: <Endpoint id> # for no-flow and no-citation
    interface: <Interface id>
    message: plain words
```

It is derived, like the spec header: rewritten whole by each run, never edited by hand. It is not a catalog record (C1 is unchanged).

### How a call-out is matched (deterministic)

For each step with `to` (call-outs and publishes):

1. The target component must be a Component in the catalog, else `no-target`.
2. **Interface.** An Interface the step names (in `to.entry` or `refs`) that goes to the target, else the best Interface from the caller's components (the flow's component and the repo's) to the target with the same method (when both have one) and a matching path. Paths match when they are the same once parameters are `{}`, or when the shorter is the other's tail and keeps a plain segment (a base URL or a context path in front): `/api/customers/{id}` matches `/customers/{customerId}`, `/api/customers/{id}/points` does not. Through a gateway, the Interface's path also counts without its GatewayRoute's base path. The callee entry point is the Interface's `endpoint`, else the target's best entry point for the Interface's method and paths (`how: interface`).
3. **Endpoint.** With no Interface, a `to.entry` that is an Endpoint id is the callee (`how: endpoint`).
4. **Path.** Otherwise the target component's best entry point by method and path, by the same rule (`how: path`). None: `no-target`.
5. The callee flow is the flow whose trigger `ref` is that entry point (or that lists it in `family`). None: `no-flow`.
6. **A citation at both ends.** The caller step's first citation and the callee trigger's first citation must each be a file and line, and, where the repo's clone is in the metarepo, a line that exists. Otherwise `no-citation`, saying which end.

The same path rule now decides whether `atticus spec check` finds a call-out's target, so a call through a context path is no longer reported as a target the catalog doesn't have.

### End-to-end flows and field lineage

- `atticus estate flow <flow-id> [--depth 5] [--json]` prints the flow with each joined callee's steps inline at its call-out (numbered `2`, `2.1`, `2.1.3`), recursively, up to `--depth` crossings, never entering a flow already on the path (a cycle). At each crossing it prints what the caller sends, what the callee's first step takes, what the callee's responses return, and sent fields the callee never names. A call-out not joined shows why; one whose join no longer fits the step (the specs changed since the join) says to run `atticus estate join` again.
- `atticus estate lineage <flow-id> <field> [--json]` (first version) walks the end-to-end flow in order from the first step whose `data.sends` names the field; a transform's `data.from[i]` becomes `data.to[i]`; any later step whose data names one of the field's names is a link; a write whose `store.columns` holds one ends the chain. Names compare on their last dotted part, letter case, `_` and `-` aside. Each link cites its step's file and line. When no write stores it, it says where it breaks: after the last step that named it, and why (nothing later names it, or the call-out that carries it isn't joined and why, or the callee isn't followed). It exits 0 when the field reaches a column and 1 when it breaks.

### The bench

`atticus bench run --specs` (new `--estate <id>` filter) keeps single-repo scoring as it was, and for each estate of two or more repos in `bench/repos.yaml` also runs the estate pass: the estate's repos adopted into one metarepo at `<cache>/estates/<estate>/` (one org pack; each clone linked in at `workspace/<id>` with a directory junction, so nothing is copied), their saved scan settings and their drafted specs from the cache, scanned together, then `atticus estate join`. The spec score adds `endToEnd`: of the reference flows that cross repos, those whose trigger's drafted flow reaches, through the joins, a drafted flow matching every later segment. Specs drafted in the estate metarepo are kept in `<cache>/estate-specs/<estate>/` and used before the ones drafted alone.

## Settled while building it

- **Joins read the first citation** of the caller step and of the callee trigger. A step citing several lines joins on the first.
- **`no-target` covers both** "the component isn't in the catalog" and "no entry point or Interface reaches it"; the message says which.
- **Ties.** The longest path match wins; among equal matches the catalog's order decides. Ambiguity is not reported yet.
- **Topics.** A publish's topic matches an event-topic entry point of the target by name, case aside. Consumers in several components need one call-out per target; fan-out is not modelled.
- **Lineage starts at `sends`.** A field that first appears in `reads` or `returns` is not followed; the chain says no step sends it.

## Consequences

- No existing contract changes: C1 keeps its kinds; the new file has its own schema version 1.
- The estate pass is only as good as the call-outs in the specs. Specs drafted with a repo scanned alone have none that cross repos; on the bench, petclinic's UI specs must be drafted again in the estate metarepo for the score to move.
- Features detected across flows (the rest of I12) and the AI's review of joins are not part of this decision.
