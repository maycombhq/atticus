# 0193. Absorbing a component into another, and strokes from a file

- Status: accepted (pending review by the product owner)
- Date: 2026-11-10
- Builds on: ADR 0108 (the change diagram), ADR 0111 (base pins), ADR 0132 (where a new component runs), ADR 0179 (a change sketched on the canvas), ADR 0180 (component types), ADR 0189 (the retire stroke)
- Contracts: no catalog (C1), dialect (C2), rule (C3), AI runtime (C5) or org-pack (C6) change. The flow delta file (ADR 0087) is unchanged: an absorb writes ordinary `new`, `remove` and `modify` deltas. The sketch stroke gains the kind `absorb` (planner `Stroke`); the local API's `SketchStrokeRequest` kind list is not widened yet, so the canvas can list and undo an absorb but not draw one (see Consequences).

## Context

A consolidation (many small services folded into a few) was the hardest change to draw. Each wrapper's flows had to be redrawn on the new service, the wrapper retired, and every caller's line dragged to the new service, one stroke at a time: hundreds of strokes for an estate of twenty wrappers. And `atticus change sketch --from` read only pictures: a line from a box the catalog doesn't have yet was skipped, so the new service couldn't come from a file at all.

## Decision

1. **The `absorb` stroke** (`applyStroke`, planner, pure): `{ kind: absorb, component: A, into: { component: B, runsOn? }, why }`.
   - Each flow of A today becomes a new flow of B (`<B>.<A's flow name>`, made unique) with the same trigger, entry (the trigger's endpoint as `METHOD /path`) and steps; a step that called A calls B.
   - Each flow of A is removed, as the retire stroke does.
   - Each step of today's map that calls A is taken out and added again calling B at the **same entry**, so the callers' contracts don't change (a gateway proxy keeps its route and changes only its target).
   - B may be a component the catalog doesn't have: the moved flows say where it runs (`runsOn`, with its type).
   - Refused, with the reason: A unknown; A into itself; B serves the entry already; a flow of A already changed in the change; a caller's step already changed. A component with callers but no flows yet only moves its callers.
   - Every part carries the one stroke's mark, so one Undo (from any of its flows) takes it all back, and the canvas lists it once (`absorbed A into B`).
2. **The change diagram marks a component retired** when the change removes every flow it has today (a retired or absorbed component); a removed flow alone still says only that the flow goes.
3. **A strokes file.** `atticus change sketch <change> --from strokes.yaml|.json [--save]` reads a list of strokes, or `strokes: [ ... ]`, each checked against the Stroke schema and applied in the file's order through `applyStroke`, with the same preview and `--save` as a picture. A stroke that can't be drawn is left out with its reason; an id the map doesn't have gets the nearest component ids ("Did you mean …"), never a guess applied. It is the reliable way to bring a design drawn elsewhere in: what each stroke does is said, not read from a picture.

```yaml
strokes:
  - kind: absorb
    component: forge-accounts-wrapper
    into: { component: forge-api, runsOn: { type: service, platform: cloud-run } }
    why: One API service instead of a wrapper each
  - kind: absorb
    component: forge-cards-wrapper
    into: { component: forge-api }
    why: One API service instead of a wrapper each
```

### A path prefix

Components that serve the same paths (two wrappers each answering `GET /search`) can't land on one target as they are: a second flow at the same entry is refused. `into.prefix` (`/legacy-cards`) puts every moved flow's entry under that path on the target, and every caller is sent to the prefixed path. A gateway proxy's own contract is unchanged; only where it routes changes.

### Absorbing again takes only what is new

A repo may still be worked on after it is absorbed (an API added to it while the migration runs). Absorbing it again into the same component, after the map is read again, moves only the flows not moved yet and sends on only callers not sent yet; what the first absorb drew is untouched, and the second has its own Undo. With nothing new, the stroke says so. Absorbing into a different component what is absorbed already is refused.

## Consequences

- A consolidation of twenty wrappers is twenty lines of a file, previewed, then written once; the architecture stage keeps every drawn step as drawn (ADR 0179).
- Not done: the canvas can't draw an absorb yet (the API's stroke kinds aren't widened, a C4 change for the integrator); the draw.io reader doesn't read new or retired boxes or absorb lines; `conform` (ADR 0114) isn't taught that a moved flow is expected on B's repo.
- A step a person drew earlier, on a new flow, that calls A is not sent to B by a later absorb; draw that one again.
- Fixture: `fixtures/consolidation/` (three invented Forge wrappers behind their gateway proxies, absorbed into `forge-api`).
