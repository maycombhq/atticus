# Diagram spike: layout engines and legibility limits

Revamp plan, Phase 1 (P1.6). Question: can a browser-side layout engine draw Atticus's graphs legibly, which one, and what limits must every view meet in Phase 4? Measured 2026-10-21 in a throwaway project outside the repo, with ELK.js 0.9.3 (layered, orthogonal routing, nested groups) and dagre 1.1.4, on NadiEngine's real views, a flow built from the microservices-demo bench reference, and synthetic nested estates.

Scores per layout: **crossings per edge** (pairs of edge segments that cross, over the number of edges), **overlaps** (boxes on top of each other), average edge length, size in 1600×900 screens at 100% zoom, and time.

## Results

| Graph                                        | Nodes | Edges | ELK crossings/edge |            ELK time |    dagre crossings/edge | dagre time |
| -------------------------------------------- | ----: | ----: | -----------------: | ------------------: | ----------------------: | ---------: |
| NadiEngine container (components, all edges) |    20 |    54 |               1.63 |               0.5 s |    failed (group cycle) |            |
| NadiEngine data (tables in one store)        |    57 |   103 |              11.96 |               0.4 s |                   10.53 |      0.3 s |
| microservices-demo calls, a lane per service |    19 |    22 |               0.55 |               0.2 s |                    0.73 |      0.1 s |
| Estate, 40 repos × 8, nested                 |   320 |   363 |               0.36 |               1.3 s |                    1.10 |      4.5 s |
| Estate, 120 repos × 8, nested                |   960 | 1,080 |               0.79 |               2.5 s | failed (internal error) |            |
| Estate, 300 repos × 10, nested               | 3,000 | 3,304 |               2.25 | 8.3 s (316 screens) |                 not run |            |

No layout overlapped boxes. ELK's tuning options (direction, node placement, model order, thoroughness) changed crossings by under 3% on the dense views: the density is in the data, not the settings.

What made the dense views legible:

| View                                                  | Technique                                              | Crossings/edge before → after                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| NadiEngine data (57 tables)                           | **Focus**: one table and its direct neighbours         | 11.96 → 0.0 (all 57 focus views crossing-free; 4.6 nodes on average)                            |
| NadiEngine module dependencies (15 modules, 53 edges) | **Transitive reduction**: drop A→C when A→B→C exists   | 1.79 → 0.21 (24 edges left)                                                                     |
| NadiEngine runtime calls                              | **Merging parallel edges** (175 calls from web to api) | one edge with a count                                                                           |
| Data view, tables folded into their store             | Collapse groups                                        | 0.0, but only 3 boxes: too much hidden; collapse is for the estate overview, not inside a store |

## Decisions

1. **Layout engine: ELK.js.** It handles nested groups with orthogonal routing, stays fast to about a thousand nodes, and beats dagre on every nested graph. **dagre is not a fallback for grouped views**: it failed on two of the four nested graphs. If ELK.js (EPL-2.0) isn't allowed by the bank's licence policy, the fallback is flat views only (dagre, MIT) with groups drawn as background boxes, and that must be decided before Phase 4.
2. **Rendering:** React Flow (MIT), with ELK in a web worker. The interactive part (dragging, pinning, keyboard, a large overview) still has to be tried in a browser; that is the spike's open item.

## Limits every view must meet (Phase 4 exit)

| Measure                                | Limit                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Crossings per edge on first render     | at most 0.5 (the nested estates of up to 320 nodes reach 0.36)                  |
| Boxes overlapping                      | none                                                                            |
| Nodes drawn at once in a detailed view | at most about 60; beyond that the view groups or switches to focus              |
| Leaf nodes laid out in an overview     | at most about 300; beyond that repos collapse to one box each, opened on demand |
| Layout time                            | under 1.5 s for 500 nodes, off the main thread                                  |

## Rules the views follow

- Merge parallel edges into one with a count.
- Dependency lenses ("uses", "builds on") draw the transitive reduction by default; the full set is a toggle.
- Table-level data views open in focus (a table and its neighbours); the store-level view shows stores and who reads and writes them.
- The estate overview shows repos as boxes; opening one lays out its components inside, keeping the rest in place.
- A view over the crossing limit after these rules offers focus mode instead of drawing a tangle.

## Not yet tried

- React Flow in a browser: dragging with live rerouting, pinning, keyboard navigation, minimap, and frame rate on a 1,000-node overview.
- Swimlane layout for the hand-written reference flows (P1.3), once they exist: lanes per repo, steps in order.
