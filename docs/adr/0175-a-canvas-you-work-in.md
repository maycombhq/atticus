# 0175. A canvas you work in: layers, filters, blast radius, trace, health, compare, saved views, export, open the code

- Status: accepted (pending review by the product owner)
- Date: 2026-11-06
- Builds on: ADR 0081 (the hierarchical canvas and kept arrangements), 0135 (how a link was joined), 0164 (contract marks), 0174 (corrections on the canvas)
- Contracts: C4 (local API 2.54.0) gains `GET /api/graph/views`, `PUT /api/graph/views/{name}` and `GET /api/code-link`, all additive

## Context

The canvas fitted, zoomed, found, focused, explained a link and took a correction, but on a 40-repo estate a person still couldn't answer "what does this team's code reach", "what breaks if this changes", "what is still open here" or "what changed since I paired those calls" without leaving it.

## Decision

Every tool works on the picture already loaded: none asks the model anything or changes a fact.

1. **Layers**: read and cited, guesses and gaps, declared, paired by a person, outside systems, topics; and "only links whose two sides disagree" from the contract check.
2. **Filters**: `team:`, `system:`, `type:`, `path:/prefix/**` and plain words, every term holding; the boxes kept and what they link to.
3. **Blast radius**: from the selected box, upstream, downstream or both, to a depth of 1 to 5; the rest dimmed.
4. **Trace**: from the selected box, hop by hop, each link with its label; a hop selects its box.
5. **Health overlay**: boxes coloured and counted by gaps, or by open questions per repo (the Questions list's counts).
6. **Inbox**: the boxes and links of the picture with gaps, most first; each selects its box.
7. **Compare**: a snapshot of the links, kept in the page; later, links added since are marked new and those gone listed.
8. **Saved views**: a name for the filter, layers and overlay, kept as `diagrams/views/<name>.yaml` for review and shared by committing it.
9. **Export**: Mermaid, draw.io, SVG, PNG, and print or PDF, of what is drawn, labels intact; a person's word dashed.
10. **Open the code**: a box's citation opens the file at its line in VS Code or IntelliJ, from the repo's checkout in the workspace.
11. **A person's word is dashed**: links declared or paired on the canvas are drawn dashed, and say so.

Grouping stays the hierarchy (estate, systems, repos, components) with parts opened in place; Arrange stays drag, Keep, Tidy up and Reset (ADR 0081). Each tool has a keyboard path and passes WCAG 2.1 AA; labels drop out when zoomed out.

## Consequences

- Nothing here can make the picture wrong: layers and filters only hide, compare only marks, the overlay only counts.
- A kept view is a file, reviewed like the rest of the metarepo; the compare snapshot is the page's only and is gone on reload.
- Export draws straight links between where the layout put the boxes; the canvas's routed lines are not copied.
