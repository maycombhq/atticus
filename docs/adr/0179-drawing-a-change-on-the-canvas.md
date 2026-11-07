# 0179. Drawing a change on the canvas: strokes into target flows

- Status: accepted (pending review by the product owner)
- Date: 2026-11-07
- Builds on: ADR 0087 (target flows), ADR 0108 (the change diagram), ADR 0111 (base pins), ADR 0132 (where a new component runs), ADR 0174 (G3, a person's word on the canvas)
- Contracts: C4 (local API 2.58.0) adds `GET`/`POST /api/changes/{changeId}/sketch`; additive. The target-flow delta file (ADR 0087) is unchanged: a drawn step is an ordinary `add`/`remove` step whose delta `why` says it was drawn.

## Context

A change's architecture was written by the architecture stage from the brief and today's map, then read as a picture (ADR 0108). Architects start the other way round: they draw. On the canvas a person could correct today's map (declare a link, connect two boxes, ADR 0174) but could not say "this change adds a call from orders to a new fraud service", and had to write a target-flow YAML by hand or coax the stage into it. The plan `docs/plan/canvas-for-changes.md` sets out the fix.

## Decision

A **stroke** is one thing a person draws for a change: a `call` (a component's flow calls another component's API, new or existing), a `topic` (published, with an optional listener on another flow), a `table` (read, written or looked up, new or existing), a `remove` (a step of today's flow taken out, with why), a `retarget` (a step's line dragged to another API: removed and added after it), or an `undo` (a drawn step taken back). `applyStroke` (planner, pure) turns a stroke into a flow delta: on the component's one flow, on the flow the person names when it has several (the API answers `pick`), or on a **new flow** the person names (with its trigger and, for a component the catalog lacks, where it runs, ADR 0132), so a new box is a new flow of a new component. Each step it adds carries a mark in its `why` (`drawn on the canvas by <person>, stroke <id>`; a retarget's two steps share one id), and each delta it makes `why: Drawn on the canvas by <person>.`, so Undo finds exactly the stroke (never a step the stage wrote) and the stage finds its frame; a drawn delta with nothing left after an undo is removed, a stage's delta is kept.

The API previews or writes a stroke as a plan of files: the changed flows' delta files (the stage's header and base pins; other deltas untouched) and, where Atticus wrote them, `design.md` and `data.md` rendered from every delta. The preview shows that plan line by line and the write writes exactly it, under a file lock; the preview carries a fingerprint of the target flows, and a write whose fingerprint no longer matches is refused (409) so a stroke never lands on files the person hasn't seen. A delta file that doesn't read blocks every stroke until fixed (a write would lose it). It returns the change's picture after the stroke and the list of drawn steps for Undo. Nothing is written without the person's yes; the panel's **Draw it** is off until the form as it stands has been previewed.

The architecture stage reads the drawn deltas first and is told: keep every drawn step where it is, draft the ones around them, never remove or move one.

## What doesn't change

A stroke is a plan, reviewed in the change's pull request like any target flow; it is never a fact and never changes today's map (rule 6: a document never overrides a fact verified from code, and a drawing is a document). Only the change's own folder is written. The picture's marks (+ new, ◇ changed, ✕ retired) come from the target flows as before.

## Consequences

- An architect can draw a change before any stage runs, and the stage completes the drawing rather than replacing it.
- `atticus change sketch <change> --from <file.drawio|.mmd> [--save]` reads a draw.io export (the reconcile reader) or a Mermaid flowchart as the same strokes through `applyStroke`: a line marked new or not on today's map is a call (a topic when its label names one), a line marked retired is today's matching step taken out, a box the catalog doesn't know is only ever a call's target; a line the file can't be read as is reported, never guessed. The editors open the Change diagram, where the panel lives.
- Two people drawing the same change at once: the second write is refused and the person draws the stroke again on the fresh picture.
