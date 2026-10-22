# 0095. A change's target flows beside today's, and loops and retries as frames (Flow schema v2)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0079 (repo specs and flows), ADR 0087 (the stage loops and target-flows/), ADR 0092 (the Flows screen)

## Context

Two things were left out of the Flows screen (ADR 0092):

1. **A change's target flows.** `atticus change architecture` writes a delta per flow in `target-flows/<flow>.yaml`: the steps it adds, changes or removes by their place in today's flow, or a new flow's steps. No screen drew them. A person had to read the deltas next to the spec and work out the result.
2. **Loops and retries.** The step kinds `loop` and `retry` existed, but a flow didn't say which steps they repeat. The schema said they "wrap the steps after them", and that is not how they occur. NadiEngine's "Save a chart" ends with a retry (step 8) that runs the lookup and the save (steps 4 to 7) again, which all come before it. Without the scope a frame can't be drawn, and a reader can't tell what repeats.

## Decision

1. **Flow schema version 2 (C1).**
   - A loop or retry step may carry `repeats: { from, to }`: the steps it repeats, by their numbers in the flow, first to last. They may come before it or after it. Only a loop or retry may carry it, and the numbers must be steps of the flow.
   - Version-1 files are read as they are and come back as version 2 in memory, as catalog records were in ADR 0031. Writers write version 2.
   - `atticus upgrade` has a new step, `flow-schema-v2`, that rewrites old flow files (127 on NadiEngine).
2. **The spec template and the drafter.**
   - The default template's `loop` and `retry` now require `repeats` (a new step requirement). `atticus spec check` reports a loop or retry without it as `template-requires`, like any other missing requirement, so existing specs get the finding on their next check.
   - The spec drafter's prompt shows the field and gives an example each way: a loop over the next steps, and a retry of a save above it.
   - The template's version stays 1. The change only adds a requirement, and the flows' `template` field keeps meaning the template they were written against.
3. **Target-flow deltas** may carry `repeats` on a step, in target-flow numbers.
4. **Today and target as one list (planner `mergeDelta`).** A delta and today's flow become one list of steps:
   - each step is marked `same`, `changed` (with what it did before), `added` or `removed`;
   - each step has its number in today's flow and in the target flow;
   - today's `repeats` are moved to target numbers;
   - a new flow is all `added`, and a removed flow all `removed`;
   - a change to a flow that isn't in the spec says so.
5. **The API (C4, 2.4.0 → 2.5.0).** Both routes read files only.
   - `GET /api/changes/{id}/target-flows` lists each target flow with its kind (new, modify, remove) and its counts (`TargetFlowList`).
   - `GET /api/changes/{id}/target-flows/{flow}` gives the merged steps (`TargetFlowView`).
6. **The Flows screen.**
   - A Change picker opens a change's target flows (`#/flows?change=<id>&flow=<flow>`). Each is drawn as one sequence, before and after at once:
     - added steps say Added, with a solid green border;
     - changed steps say Changed and what they did before, with an amber border;
     - removed steps say Removed, struck through, with a dashed border;
     - a component or table the change adds is a lane marked "new";
     - each step shows the delta's reason.
   - Every mark is in words, never colour alone.
   - A loop or retry is a bar down the left of the steps it repeats and itself, labelled ("Retry: steps 4 to 7 again"), one gutter per level of nesting. A loop without `repeats` is said as a gap.
   - A wide flow's scrolling area can be reached and scrolled from the keyboard.
   - The Architecture page links each change's target flows. The VS Code sidebar's Changes section lists them under Target flows, each opening in the Atticus tab.
7. **No other contract changes.** The template's step requirements gain `repeats`; no other org-pack schema changes.

## Consequences

- A reviewer sees what a change does to each flow in one picture, with the reasons, before any story is written.
- A retry or loop shows what it repeats, wherever those steps are.
- Existing specs keep reading, with a `template-requires` finding on each loop or retry until it is redrafted with `repeats`. On NadiEngine that is the retry of "Save a chart" and any others like it. Spec check and `atticus upgrade` are the two steps to run.
- NadiEngine's change has five target flows marked "modify" with no step changes, written before the empty-delta fix (ADR 0087 follow-up). The screen lists them as "no step changes"; running the architecture stage again drops them.
- Not built: a side-by-side view (today on the left, target on the right). The one merged picture covers both, and adding it later wouldn't change the data.
