# Integration notes: track A (ADR 0193)

For the integrator of `feature/consolidation-and-waves`. Track A did not bump `API_VERSION`, edit `CHANGELOG.md` or `docs/build-status.md`.

## Contract changes

- None to C1, C2, C3, C5 or C6. The flow delta file is unchanged.
- Planner `Stroke` gains `absorb` (`{ kind, component, into: { component, runsOn? }, why }`). It is accepted wherever `Stroke` is parsed, including the strokes file.
- **Not done (C4):** the local API's `SketchStrokeRequest.stroke.kind` enum (`packages/core/src/api.ts`) still lists `call, topic, table, remove, retarget, undo, retire`. The canvas can list an absorb (`drawn`) and Undo it, but can't POST one. Adding `"absorb"` to that enum is a one-word additive C4 change: bump `API_VERSION` (minor), run `pnpm api:doc`, and widen the canvas when wanted.
- `changeView` (`packages/diagrams`) takes an optional fifth argument, `retired`: components shown as retired. `TargetFlows` (cli `change-map.ts`) gains `retired`. Internal, not C4.

## CHANGELOG lines

- Added: `absorb`, a sketch stroke that folds a component into another. Its flows move with the same entries, it is retired, and its callers now call the other at the same entry, so their contracts don't change. One Undo takes it all back (ADR 0193).
- Added: `atticus change sketch <change> --from strokes.yaml|.json` reads the canvas's strokes from a file, applied in order, with the same preview and `--save`; an unknown component id gets the nearest ids as "Did you mean" (ADR 0193).
- Changed: the change diagram marks a component retired when the change removes every flow it has today (ADR 0193).

## build-status ticket

| Ticket   | What                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-absorb | The `absorb` stroke (flows moved with their entries, the component retired, callers sent to the new component at the same entry; one Undo); strokes from a YAML/JSON file in `atticus change sketch --from`, with "did you mean"; a retired box in the change diagram when every flow goes. Not done: the API's stroke kinds (canvas can't draw an absorb), the draw.io reader for new/retired boxes and absorb lines, `conform` for moved flows. | `packages/planner/src/stages/sketch.ts`, `packages/cli/src/change-sketch.ts`, `packages/cli/src/change-map.ts`, `packages/diagrams/src/views.ts`, `fixtures/consolidation/`, ADR 0193 |

## Tests run (targeted)

- planner: `test/sketch-absorb.test.ts` (new), `test/sketch.test.ts`, `test/thread.test.ts`.
- diagrams: whole package.
- cli: `test/change-sketch-strokes.test.ts` (new), `test/change-sketch.test.ts`, `test/ui-api-sketch.test.ts`, `test/change-map-cli.test.ts`, and the cli tests that mention retire or the change map.
- Not run: the full `pnpm check`.

## Follow-ups

1. Widen the API's stroke kinds with `absorb` (above) and add the canvas affordance.
2. draw.io reader: boxes marked new or retired, an `absorb` line, `.drawio.svg`.
3. `conform` (ADR 0114): a moved flow is expected on B's repo and gone from A's.
4. An absorb doesn't re-point a step a person drew earlier, on a new flow, that calls A.
