# 0146. A repo's starting spec, seeded from its verified flows

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0006 (OpenSpec as the foundation, and its 2026-10-25 addendum: the stories stage writes spec deltas, `openspec archive` merges them), 0031 (features found in code; a confirmed feature can seed a capability spec), 0079 (a repo's spec of flows), 0124 (facts the assistant writes, projected into C1 Flow records)

## Context

Each flow a change adds or changes is a capability in the metarepo's `openspec/specs/`, and the stories stage writes `## MODIFIED Requirements` for a flow that has one and `## ADDED Requirements` for one that hasn't. A brownfield repo that has never had a change has nothing in `openspec/specs/`, so its first change writes every flow it touches as ADDED, as if the behaviour were new, and the specs only begin to describe the repo once many changes have passed through it.

The behaviour is already known: `atticus verify <repo> --write` projects the repo's verified `flow` facts into C1 Flow records under `specs/<repo>/`, each with its trigger, its steps and its error cases, and every one citing a file and a line. ADR 0031 let a confirmed feature seed a capability spec (`atticus feature spec`), but features are an Atticus 1 surface, built from the readers' records rather than the verified flows, and it writes straight into `openspec/specs/`.

The product owner's direction: Atticus seeds the baseline, then OpenSpec's own archive keeps it current, along with the hand-down that syncs the repos. No separate checker after each build.

## Decision

1. **`atticus spec seed <repo>` proposes the starting spec as an OpenSpec change** in the metarepo, `openspec/changes/seed-<repo>/` (created with `openspec new change`, the metarepo's default schema), never a file in a code repo and never straight into `openspec/specs/`. It has `proposal.md` (why, the capabilities, the flows not seeded and how to accept it) and one `specs/<capability>/spec.md` per flow, all `## ADDED Requirements`. It has no `change.yaml`: it is not an Atticus change and has no stages, owners or hand-off, so `atticus change list` doesn't show it.

2. **The shape, from the flow alone, with no model call** (`seedSpec`, `packages/planner/src/stages/openspec-seed.ts`):
   - A capability per flow, named by `capabilityOf`, the stories stage's own naming (the flow's name part, with the repo in front when the estate has several), with the Purpose the stories stage writes for a new one (`Behaviour of flow \`<id>\` …`).
   - One requirement per flow, named after the flow, whose text says the system SHALL behave as the flow does in the code today, started by its trigger (cited), and ends `Flow: \`<id>\``, the line `specDeltas` already finds a flow's requirement by.
   - A scenario for the main path (WHEN the trigger; THEN and AND each step that is neither the entry nor a branch, in order), one per `branch` step (WHEN the trigger, THEN the branch's words) and one per error case (WHEN the trigger, AND the error's `when`, THEN its `then`). Every bullet is a step's, a trigger's or an error's own words followed by the lines it cites (`path:line`, with the repo in front when another repo's file is cited). Nothing is added where the flow says nothing: no invented condition, outcome or data.
   - Flows that aren't the code today (`planned-new`, `retired`) are not seeded, and a flow whose capability `openspec/specs/` already has is left to the changes; the proposal lists both.

3. **A person accepts each repo's seed** with `atticus spec accept <repo>`: `openspec validate --strict`, then `openspec archive`, which writes the capabilities into `openspec/specs/`. The proposal records who accepted it and when (`Accepted by <who> on <date>.`), and the archived change keeps it. The person reads and edits the specs first; a file whose first line (the mark) they delete is theirs, and a second `spec seed` keeps it. The metarepo's pull request is the review of the shared write, as for any change.

4. **The first change modifies the seed.** Nothing new in the stories stage: once the seed is archived, `specDeltas` finds the capability (by the flow its Purpose names, else by name) and the requirement (by its `Flow:` line), and writes MODIFIED, keeping every seeded scenario and adding the stories' criteria beside them, as for any archived requirement. From then on OpenSpec's archive of each change keeps the repo's specs current.

5. **No contract changes.** The seed reads C1 Flow records and writes OpenSpec files; the facts file, C1 and the org-flow schema are unchanged. `renderSpecDelta` and `writeSpecFiles` take the first-line mark as an argument (the stories stage's by default), so the seed's files are refreshed only while they carry the seed's mark.

## Consequences

- A repo's specs describe it from its first change, and that change's deltas show only what it changes.
- The seed is as good as the verified flows: a flow the reader missed is missing from the seed, and a step's words are the reader's. The citations let the person check each line against the code before accepting.
- A seed left open while a change on the same flow is drafted makes the change write ADDED (the specs don't have the capability yet), and archiving both would fail on a requirement added twice. Accept the seed, then run the change's stories stage again.
- The app has no page for it yet; the Changes page lists Atticus changes, which the seed isn't.
