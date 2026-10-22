# 0092. The Flows screen: each spec flow as a sequence diagram, and the specs API

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0079 (repo specs and flows), ADR 0085 (the estate pass's joins), ADR 0081 (the Architecture workspace), ADR 0091 (the app in a VS Code tab)

## Context

The lowest grain Atticus describes is the flow (ADR 0079): what happens, step by step, when something starts it. A flow says who calls, through which gateway, and what the code does. It also names the components, tables and topics the flow reaches, with the data at each step and a citation on every step. The app drew none of it. The Architecture canvas draws systems, repos, components, endpoints and tables, so a person could read a flow only as YAML. The product owner asked for the diagrams in VS Code (ADR 0091), and flows are the diagram people need most.

## Decision

1. **The specs API (C4, API 2.3.0).** It reads files only.
   - `GET /api/specs` lists the repos with a spec folder and each one's flow count (`SpecList`).
   - `GET /api/specs/{repo}` gives each flow's id, name, component, trigger, the number of steps, how many are confirmed, error paths, and joins out and in (`SpecView`). It also lists the files that don't read.
   - `GET /api/specs/{repo}/flows/{flowId}` gives the flow record with links from `specs/estate.yaml` (`FlowView`):
     - the flows its call-outs start;
     - the flows whose call-outs start it;
     - the call-outs the estate pass couldn't join, with why;
     - `joined: false` when the estate pass hasn't run.
   - A repo with no spec, or a flow it doesn't have, is a 404. A name that isn't an id is a 400.
2. **The Flows screen** (`#/flows?repo=<repo>&flow=<id>`, under More → Know). A repo picker, and a list of its flows with a search (`?q=` starts it). Each flow shows its name, what starts it, and its steps and confirmed count. The picked flow is drawn as a sequence diagram:
   - Lanes:
     - who starts it (the caller the spec names; else a person for an action or page, a schedule for a job, a message for a listener; else "Caller not known", said as a gap);
     - the gateway, when the call comes through one;
     - the flow's component;
     - then each component, table and topic its steps reach, in the order they are first reached.
   - One row per step, in order. A call-out's arrow goes to the called component, labelled with the entry point. A read, lookup or write goes to its table, a publish to its topic, and a response back to the caller (dashed).
   - Each step shows:
     - its kind and plain sentence;
     - the data it sends, returns, reads, checks or maps;
     - the columns it touches;
     - its file and line (the full path on hover);
     - who confirmed it, in words ("Not confirmed yet" too, never colour alone).
   - A joined call-out links to the flow it starts, in whichever repo that is. "Called by" links the flows that call this one. The error paths are listed under the diagram with their citations.
   - The steps are an ordered list. Where an arrow goes is also said in text, so the diagram reads the same without seeing it. It passes axe at WCAG 2.1 AA.
   - It is a pure function of `FlowView` (`screens/flows/model.ts`). Equal columns line up boxes, arrows and lifelines, and nothing needs a layout engine. A wide flow scrolls inside its own box.
3. **Links into it.**
   - The Architecture details panel of a repo has "Flows of this repo".
   - In VS Code, `@atticus /diagram <repo> <flow id>` opens a flow, and `@atticus /diagram <repo> <words>` opens the repo's flows with the search filled in. `@atticus /diagram <repo> flows` opens the list.
4. **The Architecture canvas, easier to read** (found on NadiEngine's 25-component repo view):
   - a gap every part of the picture has is said once above it, not on every box;
   - a fit never zooms out below 0.6, so a big picture pans instead of shrinking past reading;
   - the tour doesn't start by itself inside an editor's tab;
   - a kind label inside a primary button keeps 4.5:1 contrast.
5. **Contract change.** C4 gains three GET routes and three response schemas, all additions (API 2.2.0 → 2.3.0). Old clients are unaffected, so there is no migration. No record, org-pack, plugin SDK or AI runtime change.

## Consequences

- A person can follow a flow from the vendor's call through the gateway, the lookups, transforms, writes and events, and across to the next repo's flow. Every step shows its file and line and whether it is confirmed.
- What the diagram shows is only as good as the spec. On NadiEngine most callers aren't known yet, and the estate pass hasn't run there, so calls aren't linked across repos. The screen says both instead of hiding them.
- Not built: drawing a change's target flows (the flow deltas of `atticus change architecture`) as a before and after; dragging steps, since a sequence has a fixed order; loop and retry drawn as frames around the steps they wrap (they are rows today).
