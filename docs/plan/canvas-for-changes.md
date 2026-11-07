# Plan: drawing a change on the canvas, and matching calls to APIs at scale

- Status: proposal, for discussion (not scheduled)
- Date: 2026-11-07
- Builds on: ADR 0108 (a change drawn from its target flows), ADR 0174 (correcting the map on the canvas), ADR 0175 (a canvas you work in), ADR 0176 (reading rules)

## What is there today

Two things draw architecture:

1. **The estate canvas** (`#/architecture`, ADR 0081, 0174, 0175): the map as read from code. A person can connect two boxes, set an owner, declare a topic or route, add a box, filter, trace, compare and export. Every write goes to a reviewed file; nothing a person draws is a fact.
2. **The change diagram** (`#/change-diagram?change=`, ADR 0108): a change's picture, drawn from its target flows (`openspec/changes/<change>/target-flows/*.yaml`) merged with today's flows. Boxes and lines carry **+ new**, **◇ changed**, **✕ retired**. It is read-only: the architecture stage (Copilot, hand-off or copilot-acp) writes the target flows; the picture follows.

So designing a change is one-way: words in, picture out. An architect who thinks in boxes has to describe the design to the assistant, run the stage, look at the picture, and go round again. And **Connect to…** on the estate canvas offers one suggestion per loose call from four shapes (same path, prefix, parameter, names alike) and no help when a component has hundreds of APIs or when none of the four shapes fits.

## Proposal A: sketch a change on the canvas, and the target flows follow

**Idea.** Open a change on the estate canvas ("Design this change on the canvas"). The picture is today's map; a **change layer** sits on it. On that layer the person draws what the change does, and each stroke becomes a target-flow delta, written as the files the stages already use. The assistant then fills in what a sketch can't say (fields, steps, tables) from the sketch, not from nothing.

**What a person can draw**

| Stroke on the canvas                                          | What it writes                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A new line from component A to an API of B                    | a `DeltaStep` on A's flow: a call to B's entry, marked new; a `FlowDelta` (`modify`) for the flow it sits in, or `new` when A has no flow yet |
| A line from A to a **new** API on B (typed as `METHOD /path`) | the same, plus an entry step on a new or modified flow of B, marked new                                                                       |
| Delete a line                                                 | the call's step marked removed                                                                                                                |
| Drag a line's end from B to C                                 | today's step removed, a new one to C (ADR 0108 already draws this as retired + new)                                                           |
| A new box (component or system)                               | `runsOn` on its first new flow (ADR 0132); the box is drawn **+ new**                                                                         |
| A new topic between A and B                                   | a publish step on A, a listener on B's new or modified flow                                                                                   |
| A table under A (new or changed)                              | a store step with `table`, `columns`, `new`                                                                                                   |

Every stroke shows a small form first (which flow of A, which entry of B, what the step does in a sentence), with the pick already made where the canvas can tell. Nothing is written without the person's yes, as Connect does today; the diff of the target-flow file is the preview.

**Then the assistant.** "Fill in the rest" runs the architecture stage (hand-off or copilot-acp, as the runtime allows) **with the sketch as its brief**: the deltas on file are the frame, and the stage adds fields, errors, steps it can read from the code, and questions where it can't. The stage already loops; this only changes what it is given. The person sees the picture update as the stage writes, with the change diagram's marks.

**Where it shows**

- The estate canvas gets a **Change** picker in the tools panel (none, or one change). With a change picked the change layer is on, the legend shows + ◇ ✕, and Connect/Add box/Declare write deltas instead of corrections. Compare (ADR 0175) comes free: today vs the change.
- The change diagram screen stays as the read-only review view, and gains **Open on the canvas**.
- `atticus change sketch <change> --from <file.drawio|.mmd>` reads a draw.io or Mermaid export back into deltas (the diagrams package already parses draw.io for reconcile), for architects who draw elsewhere first.

**What it must not do**

- A stroke never becomes a fact. It is a target flow, reviewed in the change's PR, and the map changes only when code lands and is read (ADR 0108's consequence stands).
- A new box drawn on the change layer is **planned**; it does not go into the profile until the change is released (today's Add box writes the profile at once: keep that for the estate, not for a change).
- The assistant fills in, never redraws: a step the person drew is kept as drawn unless the person removes it.

**Order of work** (each with ADR, tests, docs, as usual)

1. Core: `sketchDelta(root, change, stroke) → FlowDelta file edits` with preview (the manifest-edit pattern: comments kept, CRLF kept, `writeFileIfUnchanged`). Golden tests per stroke.
2. API 2.57: `GET /api/changes/{id}/canvas` (today's graph + change layer), `POST /api/changes/{id}/sketch` (preview and write), `POST /api/changes/{id}/fill` (starts the architecture stage with the sketch as brief; copilot-acp through the existing run route).
3. UI: change picker, change layer, the stroke forms, the fill button, marks and legend on the estate canvas; the change diagram's Open on the canvas.
4. CLI: `change sketch` import from draw.io/Mermaid; `change map` unchanged.
5. VS Code/IntelliJ: open a change on the canvas from the change's tree item.

Rough size: core 3–4 days, API 1, UI 4–5, CLI 1, editors 1; about two weeks with reviews.

## Proposal B: match calls to APIs at scale (asked from the UI)

**Problem.** Connect lists A's loose calls and B's APIs, each call with at most one suggestion from four string shapes. A gateway or platform component with hundreds of routes, or a client whose paths are built from constants and settings, gets nothing useful, and the person pairs by hand, one at a time.

**Three layers of matching, from cheap to costly, all asked for by the person from the Connect panel:**

1. **Match more shapes (no model).** Add to `link-candidates`: path templates with placeholders resolved from the caller's settings (`${api.base}/accounts/{id}` against `/v1/accounts/{accountId}`), method-aware scoring, OpenAPI `operationId` and summary words against the call site's method and variable names, version prefixes (`/v1`, `/v2`), and the gateway's route→target map when B is a gateway (match against the forwarded path, not the route). Give every call a ranked top 3, not one. Show a **Pair all confident** button for suggestions above a high threshold, with the list to untick; this is one Preview and one write, as today's rule-for-all is.
2. **Ask Copilot to match (model, from the UI).** A **Match with Copilot** button in the panel starts a copilot-acp session (the run route from ADR 0173 already exists) with a brief: A's loose calls (each with its cited lines, as the facts hold them), B's APIs (with their spec summaries), and the instruction to pair each call with one API or say none, citing the lines that made the match. The session writes nothing. Its answer comes back as **proposed pairings**, each with its reason and cited lines; the person ticks and writes them as the ordinary `link` corrections. The brief fences every piece of file content as data (the rules-draft prompt's `dataBlock`); the answer is checked (every API named must be one of B's; every call one of A's). Where copilot-acp isn't allowed, the same brief is a hand-off prompt (`atticus connect match A B --handoff`), pasted into any chat, and the answer file read back.
3. **Learn the shape as a reading rule.** When the person pairs a few calls that share a shape (`captureChargePath` → `/charges/{id}/capture`), "Make this a rule for every repo of this type" (ADR 0176, already there) writes the rule so the **next read** resolves such calls itself. This is the long-term fix: fewer loose calls over time, not better pairing of them.

**Order of work**

1. Core `link-candidates`: the extra shapes, a top-3 per call, gateway-aware matching, `confident` on a suggestion. Golden tests on an invented gateway with ~300 routes.
2. UI Connect: a Pick list per call (top 3, "other…" opens the search over all of B's APIs with type-ahead), **Pair all confident**, the count of what is left.
3. Match with Copilot: the brief builder (core), `POST /api/links/match` (starts the run, same guard rails as copilot runs), the answer checker, the proposals view in Connect (tick, untick, write), the hand-off variant on the CLI.
4. Docs: `docs/guide/correcting-the-map.md` gets "many APIs" and "match with Copilot".

Rough size: a week; step 3 is half of it.

## What I'd do first

B1 and B2 (better shapes, top 3, Pair all confident) are small and help at once on a 40-repo estate. Then A1–A3 (sketching a change), then B3 (match with Copilot), then A4–A5.

## Open questions

- Should a sketched new box be allowed to pick a repo type and platform (so `runsOn` is complete), or leave that to the stage?
- When the person draws a call to an API that doesn't exist yet, do we require method and path, or allow "an API, name it later" and let the stage name it?
- Match with Copilot on a bank network: the only model call is through the runtime as today; is a copilot-acp session per Connect acceptable, or should matches be batched per repo?
