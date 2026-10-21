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

Flows are drafted, not scanned, so they are not in `catalog/generated`. They live in the metarepo at `specs/<repo>/<flow-id>.yaml`, one record per file in canonical YAML, with `specs/<repo>/spec.yaml` holding the repo's spec header (repo, commit read, template, open questions). They are stored per commit: a rescan that changes a file a step cites marks that step stale, and the next `atticus spec draft` redoes only the stale flows.

### The spec template (C6)

A repo type (ADR 0077) carries `repo-types/<id>/spec-template.yaml`: which trigger kinds a repo of that type has and how to find them (from catalog kinds: every Endpoint, every listener, every job), which step kinds occur, what each step kind must record (a write needs a table and columns; a call-out needs its target), and how flows group into families. A new type's template is drafted by the AI and reviewed in the same PR as the first repo's spec (plan 4.2).

### The commands

- `atticus spec draft <repo>`: the assistant writes one flow (or family) per trigger the template asks for, through the AI runtime (a hand-off to Copilot at the bank).
- `atticus spec check <repo>`: the deterministic critic. Every trigger in the catalog has a flow; every step cites a line that exists; a call-out names a target that is in the catalog; a field a step uses appears in an earlier step or the trigger; a write names a table and columns the catalog has; each `check` claim holds. Findings carry a fingerprint (rule, target, evidence); a finding that comes back unchanged twice becomes a question (ADR 0078).
- The estate pass (plan Phase 3) joins one repo's call-out to the flow its target starts, through the catalog's Interfaces.

## Consequences

- C1 gains one kind with schema version 1 of its own; nothing existing changes.
- The bench's reference flows are scored against drafted specs: triggers covered, steps matched in order, fields and tables named, citations correct.
- The diagram workspace's flow lens draws these records directly.
