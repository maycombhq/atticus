# 0180. Component types the organisation owns: what a kind of component is, in the org pack

- Status: accepted (pending review by the product owner)
- Date: 2026-11-07
- Builds on: ADR 0040 (`Component.type`'s documented values), ADR 0077 (repo types), ADR 0124 (facts the assistant writes), ADR 0163 (org notes), ADR 0176 (reading rules), ADR 0179 (drawing a change)
- Contracts: C6 gains `org-pack/component-types/<id>/type.yaml` (with `notes.md` beside it), additive. The facts file (ADR 0124) gains the `component` kind at version 4, additive: older files read unchanged. C4 (local API 2.60.0) adds `GET /api/component-types`. C1 is unchanged: `Component.type` stays free text.

## Context

`Component.type` has thirteen documented values hard-coded in core (service, spa, bff, gateway, worker, …) and the projection from facts knew only two of them: a component with a screen was a `spa`, everything else a `service`. Nothing let an architect say what kinds of component the organisation has (an experience API, a rules engine, a gateway proxy as _they_ define it), how a read tells one from another, where one runs, how to draw it, or what one must and must not do; and the pages drew every component the same.

## Decision

### 1. A type is a file an architect owns (C6)

`org-pack/component-types/<id>/type.yaml`: `id`, `name`, `description`, `owner`; `signals` the reader cites when it says a component is of the type (a framework, a dependency, an annotation, a file or path, a repo type, words); `runsOn` defaults for a new box; `draws` (a shape, a colour, a badge of one to three characters) for the canvas; `must` and `mustNot` in the organisation's words (org notes, ADR 0163's shape); `off: true` on a built-in's id to take it out (`name` and `description` may then be left out); `notes` naming the Markdown write-up beside it (`notes.md` by default). Atticus's thirteen types are the default set in the same shape (`BUILTIN_COMPONENT_TYPES`); the effective set is the built-ins with the pack's own, reworded and switched-off ones applied (`effectiveComponentTypes`). `atticus types list | add | notes` work on them; the app serves the set at `GET /api/component-types`.

### 2. The `component` fact (facts file, version 4)

```
component: type: text, why?: text
```

One per component: `type` is a type's id, `cite` the line that shows a signal (the dependency, the annotation, a file's first line) with the signal as `cite.value`. The verifier checks the signal on its line like any claim, rejects a type the organisation's set doesn't have (`component-type`, naming the file to add) and a second fact for the same component. The projection takes the fact's type for the Component record and keeps its citation as evidence; without one the old reading stands. `atticus map <repo> --estimate` and every batch prompt hand the reader the set, with each type's description and signals, as data (`componentTypesText`).

### 3. Where it shows

The canvas draws a component's type as a badge in its colour (the hierarchy's `properties.type` is the id), and the tools panel lists the types the picture has as a legend, each a `type:<id>` filter. Drawing a change (ADR 0179), a new box can be of a type: the stroke's new flow carries `runsOn.type` and the type's run-on defaults, and the panel shows what the type must not do. The architecture stage is handed what every type must and must not do, with the notes file named (`componentTypeRulesText`), as data, so a component it drafts is of a type and keeps to it.

### What doesn't change

`Component.type` is still free text (C1 unchanged); an unknown type is flagged at verify, never refused by the schema. A type's notes and rules are data in every prompt, never instructions (CLAUDE.md rule 6). Nothing here is a fact until a read cites it.

## Consequences

- Architects define the organisation's kinds once; reads classify against them with a citation, and the canvas shows the kinds at a glance.
- `atticus map --all --stale` re-reads nothing for a new type: a type added later is used by the next read of each repo (the set is handed at read time, not pinned per repo).
- A type's `mustNot` lines read as rules; offering them as checklist drafts (as repo-type notes are, ADR 0163) is a natural next step and not done here. The merge keeps a cited type over a repo type from the manifest (`MergeInput.componentTypes`), so an organisation's own type is never demoted to `service`.
