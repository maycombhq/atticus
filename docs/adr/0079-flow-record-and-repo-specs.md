# 0079. The Flow record and repo specs made of flows (C1, C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), 0075 (scan settings), 0077 (repo types)

## Context

The catalog stops at endpoints, tables and calls. What people draw on a whiteboard, and what a change touches, is the flow: what happens in order when something enters a repo, with the data at each step (plan 4.2). The bench now holds 20 hand-written reference flows in three estates (`bench/flows/`), up to 79 steps each, crossing repos through calls and events. They show what a flow must hold: a trigger; ordered steps of a dozen kinds; the data each step sends, reads, transforms and returns, by field; the table and columns a step writes; the entry point a call-out reaches in another repo; error paths; and a citation on every step.

## Decision

### The Flow record (C1, new kind)

```yaml
kind: Flow
id: <component>.<flow-id> # e.g. petclinic-rest.add-owner
component: petclinic-rest
name: A person adds a pet owner # plain words
trigger:
  kind: endpoint | action | page | listener | job
  ref: <Endpoint id, when the trigger is one>
  what: The Add Owner form is submitted
  evidence: [...] # the usual Evidence, path and line
steps:
  - kind: entry | lookup | read | write | call-out | publish | transform | validate | branch | log | respond | loop | retry
    what: <one sentence>
    refs: [<catalog ids the step touches: Endpoint, Interface, Table, Column, topic>]
    to: { component, entry: <Endpoint id or "METHOD /path"> } # call-out and publish only
    data: { sends, returns, reads, checks, from, to } # field names as the code names them
    store: { table: <Table id>, columns: [...] } # read and write only
    evidence: [...]
    confirmedBy: check | ai | person
errors: [{ when, then, evidence, confirmedBy }]
family: [<trigger refs>] # one flow standing for several near-identical triggers
template: <repo type id>@<version> # the spec template it was written against
```

`confirmedBy` makes principle 2 of the plan concrete: the citation check sets `check` on a step whose line names what the step claims (an endpoint path, a table, a topic, a field); the AI's verification pass sets `ai`; a person's review sets `person`. A transform or branch can never be `check`.

### Where flows live

Flows are drafted, not scanned, so they are not in `catalog/generated`. They live in the metarepo at `specs/<repo>/<id>.yaml` (the whole id, see below), one record per file in canonical YAML, with `specs/<repo>/spec.yaml` holding the repo's spec header (repo, commit read, template, open questions). They are stored per commit: a rescan that changes a file a step cites marks that step stale, and the next `atticus spec draft` redoes only the stale flows.

### The spec template (C6)

A repo type (ADR 0077) carries `repo-types/<id>/spec-template.yaml`: which trigger kinds a repo of that type has and how to find them (from catalog kinds: every Endpoint, every listener, every job), which step kinds occur, what each step kind must record (a write needs a table and columns; a call-out needs its target), and how flows group into families. A new type's template is drafted by the AI and reviewed in the same PR as the first repo's spec (plan 4.2).

### The commands

- `atticus spec draft <repo>`: the assistant writes one flow (or family) per trigger the template asks for, through the AI runtime (a hand-off to Copilot at the bank).
- `atticus spec check <repo>`: the deterministic critic. Every trigger in the catalog has a flow; every step cites a line that exists; a call-out names a target that is in the catalog; a field a step uses appears in an earlier step or the trigger; a write names a table and columns the catalog has; each `check` claim holds. Findings carry a fingerprint (rule, target, evidence); a finding that comes back unchanged twice becomes a question (ADR 0078).
- The estate pass (plan Phase 3) joins one repo's call-out to the flow its target starts, through the catalog's Interfaces.

### Settled while building it

- **File names.** A flow's file is named by its whole id, `specs/<repo>/<component>.<flow>.yaml`, not `<flow-id>.yaml`: a repo that builds two components could otherwise have two flows in one file name. It follows the catalog's rule of one file per record named by its id. Beside them: `spec.yaml` (the header) and `findings.yaml` (the critic's last findings). In a repo adopted in place the folder is `.atticus/specs/<repo>/`.
- **Common fields.** A Flow also has `status` (default `current`), `confidence` (default `inferred`), `evidence` (default empty: citations live on the trigger, steps and errors) and `flags`, so it is a `CatalogRecord` like the others; its `schemaVersion` is its own (`FLOW_SCHEMA_VERSION`, 1), which `serializeRecord` and `migrateCatalog` keep.
- **confirmedBy** is left out until something confirms a step. The citation check can't confirm a transform, branch or validation (plan principle 2 lists validation with them), nor an error path. A person's review outranks the check, and the check outranks the AI pass. The drafter never sets it.
- **The header** holds the commit read, the template, `templateReviewed` (true for the built-in default template; for a repo type's template a person sets it once its PR merges), the last draft (`at`, `run`), the flow ids, a hash of each cited file and the open questions. A cited file whose hash changed marks its flows stale: `atticus spec check` reports them, and `atticus spec draft` drafts only them, the triggers with no flow and the flows the last check found problems in (or everything with `--force`).
- **The template** (`SpecTemplate`, schema version 1) has `triggers` (kind, and `from`: every Endpoint of some endpoint types, or every Interface over some vias and directions; no `from` for pages and buttons, which the catalog can't list), `steps` (kind and `requires`: `to`, `store.table`, `store.columns`, `data.<list>`) and `families` (`by: resource`: one component's triggers on one path once trailing parameters are dropped). `DEFAULT_SPEC_TEMPLATE` (`default@1`) is used when a repo has no type or its type has no template.
- **The drafter** keeps every flow that passes the schema, the cited lines, the catalog ids, the call-out targets and the write rules, and hands back the rest with what failed; the template's `requires`, fields from nowhere and family rules are reported by `atticus spec check` and handed back on the next draft. A finding counts as unchanged when its fingerprint is in the last check and a draft happened in between; the second time, it becomes a question (ADR 0078) and is no longer handed back.
- **A `check` claim**: an entry names its trigger's route (the path, or its tail once a class-level prefix is dropped, with at least one plain segment) or topic; a call-out or publish names its target's route or topic; a read, lookup or write names its table; any other step names every field it lists (letter case, `_` and `-` aside). The claim must be on one of the step's cited lines.
- **Reach.** Registering the kind adds `Flow` to every enum that lists record kinds: the local API's OpenAPI document (C4) and the kind lists in C2 and C3. Nothing a scan or dialect produces is a Flow.

## Consequences

- C1 gains one kind with schema version 1 of its own; nothing existing changes.
- The bench's reference flows are scored against drafted specs: triggers covered, steps matched in order, fields and tables named, citations correct.
- The diagram workspace's flow lens draws these records directly.
