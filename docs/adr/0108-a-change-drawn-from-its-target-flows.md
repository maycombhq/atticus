# 0108. A change drawn from its target flows: + new, ◇ changed, ✕ retired (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0087 (the architecture stage's flow deltas), 0095 (target flows beside today's), 0068 (views and the planned legend), 0081 (the Architecture canvas), 0104 (MCP tools)

## Context

The architecture stage writes a change's target flows: per flow it touches, the steps it adds, changes or removes, where each call goes and which tables each step reads or writes (`target-flows/<flow>.yaml`). The Flows screen shows one flow at a time, step by step. Nothing shows the change as a whole: which components, entries and tables it touches, which are new, which change and which go. Reviewers draw that by hand, and the hand-drawn picture drifts from the design.

The diagrams package already draws catalog views as Mermaid and draw.io with a planned legend (new, modify, retire), and the canvas draws boxes and lines.

## Decision

A change's picture is built from its target flows, merged with today's flows (`mergeDelta`), and the catalog:

- **Boxes**: the component of each flow, every component a step calls or publishes to, every table a step reads or writes. Components sit in their system, tables in their data store.
- **Lines**: component to component (labelled with the entry; dashed when it publishes) and component to table (labelled with the step's kind).
- **Marks**, from the steps' own marks, never guessed:
  - a line: all its steps added **+ new**; all removed **✕ retired**; all the same, unmarked; else **◇ changed**. A changed step that goes elsewhere draws today's line retired and the new one added (the merge keeps where it went today).
  - a box: **+ new** only when the target flow says so (`new` on a call's target or a table, which the stage checked against the catalog) or it is a new flow's component that neither the catalog nor today's specs name; **◇ changed** when its flows change, it gains an entry, or a migration alters its columns; else unmarked, there for context. A part the catalog lacks is unknown, not new.
  - A component is never marked retired: a removed flow says that flow goes, not the component.
- The sign is in every label as well as the colour and line style (WCAG 1.4.1), and the legend reads + New, ◇ Modify, ✕ Retire in every view.

It is shown everywhere a change is worked on:

- `atticus change map <change> [--format mermaid|drawio] [--json]`;
- the local API, `GET /api/changes/{changeId}/map` (API 2.9.0): the boxes, groups and lines, the same picture as Mermaid, how many target flows it is drawn from, and what couldn't be drawn;
- the app's **Change diagram** screen (More, Design, `#/change-diagram?change=`), linked from the Architecture stage: the canvas, a legend, a table of every part and every line with its mark, and the Mermaid to copy;
- VS Code: `@atticus /changemap <change>` draws it in Copilot Chat as Mermaid, and **Open a change's diagram** opens the screen; IntelliJ: **Atticus: Change Diagram** opens the screen in its tool window; Claude Code: the `change_map` MCP tool.

## Consequences

- A reviewer sees the whole change at once, from the same files the stories and tasks are planned from, so the picture can't drift from the design.
- What isn't drawn yet: inbound callers of an entry the change alters, flows the change only reads, interfaces a person marked planned-retire in the catalog, and a contract change on an entry (a changed request or response) as its own mark. They need data the target flows don't carry yet.
