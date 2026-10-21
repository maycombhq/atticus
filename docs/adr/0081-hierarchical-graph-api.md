# 0081. The hierarchical graph API and kept diagram arrangements (C4, C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0015 (the local API), ADR 0068 (component uses), ADR 0074 (every fact cites its code)

## Context

The diagram workspace (plan 4.6) is one model of the estate that people open from the whole estate down to one element. Today the app draws fixed catalog views (`/api/diagram/{view}/graph`) with a hand-written layered layout: every view is loaded whole, nothing nests, and nothing a person arranges is kept. The plan puts "the graph API, fixed first" at the head of Phase 4, and the diagram spike (`docs/plan/diagram-spike.md`) set the rules a view must follow to stay legible: parallel edges merged with a count, dependency edges as a transitive reduction, tables opened in focus, at most about 60 nodes in a detailed view.

## Decision

**C4: three read routes and one write route**, served by `atticus ui` (`packages/cli/src/ui-api-graph.ts`), typed in `packages/core/src/api.ts` and in the OpenAPI document.

- `GET /api/graph/node/{id}?lens=&depth=&all=`: one node, its children (`depth` levels, default 1, at most 3; each names its `parent` and counts its own children so the app loads the next level when it opens), the ancestors as breadcrumbs (`path`), and its edges. An edge between two children is kept; an edge from a child to a node outside is lifted to the outside node at the nearest level (a sibling, or a sibling of an ancestor) and that node is listed in `outside`. Edges of the same type between the same two nodes are merged into one with a `count`, up to five pieces of evidence and the union of their gaps. "uses" edges are the transitive reduction unless `all=1`; `hiddenEdges` says how many the reduction left out. In the data lens a node whose children are tables suggests focus on the first table; a view of more than 60 nodes suggests grouping.
- `GET /api/graph/focus/{id}?lens=` (default lens data): a node and its direct neighbours, with every edge between them.
- `GET` and `PUT /api/graph/layout/{viewKey}`: a view's kept arrangement (below).

Node ids are `estate` or `<kind>:<record id>` (`system:ledger`, `table:ledger-db.entry`). The hierarchy is estate → system → repo → component → element, built from the catalog by `@maycombhq/diagrams` (`buildEstate`, `nodeView`, `focusView`):

| Kind        | From                                           | Parent                                                              |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| system      | System                                         | estate                                                              |
| repo        | System.repos, Component.repo                   | the first system (by id) that lists it, else its component's system |
| component   | Component                                      | its repo, else its system (gap `no-repo`)                           |
| endpoint    | Endpoint                                       | its component, else a system of that id (gap `no-component`)        |
| topic       | Endpoint of type event-topic or mq-queue       | as endpoint                                                         |
| client      | the Interfaces a component calls a target with | the calling component                                               |
| store       | DataStore                                      | its owner component, else the estate (gap `no-owner`)               |
| table       | Table                                          | its store                                                           |
| deployment  | Deployment                                     | its component                                                       |
| environment | Deployment.env                                 | estate                                                              |
| unknown     | a reference to no record                       | estate (gap `not-in-catalog`)                                       |

Edges: `calls` (client → endpoint, or the target component or system, with `sync` and `via`), `publishes` and `subscribes` (component → topic), `uses` (Component.uses), `reads` and `writes` (Table.readers and writers), `references` (a foreign key between tables), `deployed-to` (deployment → environment). Each node and edge carries its evidence as `path:line`, its `state` (current, new, changed, retired, from the record's status; today's catalogs are current) and its gap flags (`inferred` for a record seen at one end only, the record's own flags, and the missing parts above). Each node names the command for its next step (`atticus guide`, `atticus impact`, `atticus scan review`...); the app shows it and never runs it.

Lenses filter the same model: architecture (structure, endpoints, topics, clients and stores; calls, topics, uses, reads, writes), repo (all of that and tables), data (stores and tables and who reads and writes them), integration (endpoints, topics, clients and calls) and infrastructure (deployments and environments). The data, integration and infrastructure lenses show only the part of the estate their elements and edges touch. The flow lens and the behaviour hierarchy (repo → flow → step) come later, as new kinds and edge types added to this API.

**C6: a kept arrangement is a metarepo file**, `diagrams/layouts/<view-key>.yaml` (schema `DiagramLayout`, version 1, JSON Schema with the workspace files):

```yaml
schemaVersion: 1
view: architecture.system-ledger
lens: architecture
node: system:ledger
by: pat
at: 2026-10-21T10:00:00.000Z
positions:
  repo:forge-ledger: { x: 40, y: 80 }
```

The view key is `<lens>.<node>` or `<lens>.focus.<node>` with `:` written as `-`; the PUT refuses a key that isn't the one for its lens and node. Positions are pinned boxes; when the view reopens, the layout places every other box and moves none of the pinned ones (`arrange` in `@maycombhq/diagrams`). The file is people's choices, not generated catalog: it is shared through git and survives a rescan.

**Layout score.** `scoreLayout` in `@maycombhq/diagrams` measures a laid-out graph as the spike did (crossings per edge, overlapping boxes, nodes and leaves, average edge length, size in 1600×900 screens), and `overLimits` checks it against `LAYOUT_LIMITS` (the spike's table), so Phase 4 can refuse a view over the limits before it is shown.

## Consequences

- C4 gains four routes; nothing existing changes, so `API_VERSION` stays 2.0.0 (an addition, as with earlier additions). `/api/diagram/*` stays for today's Diagrams page until the workspace replaces it.
- C6 gains one optional metarepo file kind; no migration.
- The interactive canvas (React Flow with ELK.js in a web worker) isn't part of this decision's code yet: neither library is in the offline package store, and ELK.js's licence (EPL-2.0) isn't on the bundle's allowed list (`scripts/bundle/inventory.mjs`). The app's Architecture screen uses the API with today's read-only canvas until both are settled; the layout is behind the score's engine-neutral shape (`LaidOut`) so dagre can stand in for flat views.
