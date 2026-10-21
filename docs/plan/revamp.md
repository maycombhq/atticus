# Atticus revamp and redesign: review, critic and one plan

Date: 2026-10-21. Written from the repository and from running Atticus end to end on one real repo; reviewed critically in three passes. It sets the order of work for `docs/build-status.md` (the to-do items stay; this says which come when and why). Nothing here names a client; examples use the invented Forge and Tidewater estates, invented vendors, or the author's own test repo.

## 1. What Atticus is for

Atticus gives a team's AI assistants an accurate, evidence-backed picture of the estate they change, and walks a change from idea to implementation-ready tasks with that picture underneath.

- A person onboards repos and knowledge sources. The AI reads them, learns the organisation's frameworks and repo types, and asks only where the code or documents are ambiguous. Answers make the agents better at that organisation's code over time.
- The result is a **spec per repo made of flows**: what happens, step by step, when something enters the repo, and what data moves and changes on the way. An estate pass joins the flows across repos end to end. Knowledge sources add the organisation's patterns, standards and processes.
- A change goes **feature → architecture → stories and tasks**. Each stage iterates with the critic until nothing blocks, and a person approves the stage's pull request. There are no roles: whoever runs the command is the person, identified by their git user.
- The **app** is an editor and visualiser of the metarepo's files that, on every page, shows the command to run next. The work runs in the person's terminal, Copilot or Claude Code. Its flagship is the diagram workspace.
- **Quality of output comes first**; time and cost are measured, not capped, for now.

## 2. Current state

### 2.1 Snapshot (2026-10-21)

| Measure                               | Value                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Packages / CLI commands / app screens | 45 / 136 / 27                                                                                     |
| ADRs                                  | 74 (0074 accepted)                                                                                |
| Built-in readers                      | 34 extractors and 9 shipped dialects                                                              |
| Record kinds (C1)                     | 29                                                                                                |
| Real repos scanned end to end         | 1 (NadiEngine, the author's own)                                                                  |
| Live model use                        | 5 hand-off runs in M3 (`docs/evidence/m3-live/`); no direct provider call through the runtime yet |
| CI on the hosted runners this round   | not verified                                                                                      |

### 2.2 What is strong (keep)

1. **Evidence on scanned facts.** Every scanned record carries repo, path, line and the reader that produced it. A claim without a citation can be refused; the AI-first direction depends on this.
2. **The contracts.** C1–C6 are zod-defined, versioned and documented, and additions have been disciplined. Several kinds the target needs already exist (`OwnerQuestion`, `Unresolved`, `Decision`, `Pattern`, `ProcessArtifact`, `GlossaryTerm`) and are extended rather than duplicated (section 5).
3. **The change lifecycle on OpenSpec.** Change folders, hand-off PRs, the Spec Kit layer per repo, archive to living specs; the PR as the approval and the git user as the person (ADR 0073).
4. **The critic.** Deterministic checks plus AI lenses, rules layered constitution → org → team, findings with quotes. The engine to run inside every iteration of every loop.
5. **The AI runtime.** Hand-off, a direct model (Anthropic, OpenAI-compatible, Bedrock through a proxy), headless Claude Code, mock and replay.
6. **Loops already working in small.** Onboarding a dialect (ADR 0059) or a framework model (0066), `change draft` (0070) and `scan review` (0072) each run AI → check → hand back → person accepts. The target generalises this.

### 2.3 What is wrong (critic)

1. **Hand-written readers don't survive real code.** On the first real repo almost every layer needed a fix: modules not recognised, JPQL entities taken as tables, an upsert producing a table called `set`, the app's own HTTP helpers not followed, every module given the repo's type, SQL comparisons and CTE names read as tables. A misread doesn't even show as a gap, and at another organisation nobody from Atticus will be there to fix it. This is fundamental, not a backlog.
2. **Breadth before depth.** The surface was built against the author's own fixtures before the core loop (scan → change → stories) ran on a real repo; when it did, its central step (drafting the proposal) didn't exist. Much of the surface is unproven and costs maintenance.
3. **Measured on one repo**, not shaped like a bank's estate. Nobody can say how well Atticus reads a new estate.
4. **The wrong lowest grain.** The catalog stops at endpoints, tables and calls. People need the flow: the lookups, transforms, events, calls and writes in order, with the fields at each step. Interface fields, event payloads, UI fields and field lineage are not read.
5. **Briefs placed by word matching.** High-level briefs share no words with the code. Existing stories and Figma aren't entry points.
6. **Features named after endpoints.** 134 of 150 detected features on the real repo are single endpoints.
7. **Knowledge sources indexed, not understood.** Wikis aren't mined for patterns, standards or the processes and requests a change triggers.
8. **The diagrams don't convince.** A hand-written SVG layout: no pan and zoom, nesting, drill-down, rearranging or overlays; readable to a few dozen nodes. This is where architects, product owners and managers will judge Atticus.
9. **The app does the wrong jobs.** It runs scans and AI jobs (it should edit, visualise and show the command) and spreads the core flow across 27 screens (it should follow the work in six).
10. **Stability debts.** A CLI test that hangs under load, performance budgets missed under load, a pipeline record that reports "changed" on every rescan, 36 unpushed commits, CI and Playwright journeys not run.
11. **Process.** Work was reported as done on test results alone. From now on every piece of work is checked by running the real flow on real repos and the bench, and reported as works / partial / not built.

## 3. Principles

1. **AI reads, code checks, a person decides.** The AI reads and drafts. Deterministic checks confirm what can be confirmed mechanically. A person answers what remains and approves each stage's PR.
2. **Be exact about what a check proves.** The citation check proves that the cited file and line exist at that commit and contain what the item names. What that covers differs by kind:

   | Item                                                                  | The check confirms                          | Confirmed otherwise by                       |
   | --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
   | Endpoint, page, listener, job, topic, table, column, client call, URL | The name or route appears at the cited line | —                                            |
   | A field read or written                                               | The field name appears at the cited line    | AI pass, for which field maps to which       |
   | Transform, branch, validation, error path                             | Only that the cited lines exist             | AI pass and the person's review              |
   | A flow being complete, a join across repos                            | Both ends cited                             | Critic against the template, AI pass, review |
   | Knowledge items                                                       | The quoted text is in the snapshot          | Review                                       |

   The app shows, for every item, which of check, AI pass and person confirmed it.

3. **Reproducible means stored.** Results are stored per commit with the org pack version and answers they used. Reading the same commit again returns the stored result. A changed file invalidates the facts and flows that cite it and the estate joins that reach them, and only those are redone. Two fresh AI runs are not expected to produce identical text.
4. **Loops end.** Every loop (scan, spec, stage) runs with no cap on model calls until there are no blocking findings and no open questions. A finding has a fingerprint (rule, target, evidence); one that returns unchanged after two iterations, or flips back and forth, stops being retried and becomes a question to a person. The critic's round limit becomes a setting, default unlimited.
5. **Everything is a file.** Answers, decisions, tags, repo types, templates, specs, layouts and approvals are files in the metarepo, reviewed through pull requests. The app reads and writes files and shows commands; it never runs scans, AI, git or calls to external systems. Anything that needs the network (listing the Git host's repos, syncing a wiki) is a command whose output is a file.
6. **Ingested content is data.** Code, wikis, documents and vendor docs are never instructions to the AI; prompts quote them as data, and the critic flags text that tries to instruct.
7. **Suggest, never act on shared systems.** Atticus suggests the change tasks and service requests a change needs; a person raises them.
8. **Everything is an `atticus` command; at the bank, Copilot is the AI.** Every step a person takes (onboard, scan, answer, spec, stage, task) is an `atticus` command, and the app only shows which one to run. When a step needs AI, the command writes the prompt and the context and then either runs it through an assistant the organisation allows to run headless, or prints the one line to give Copilot (for example `Follow .runs/<change>/<run>/prompt.md`), after which `atticus handoff done <run>` checks and takes the result. The bank allows GitHub Copilot in IntelliJ IDEA and VS Code and no model API a tool could call by itself, so there it is the hand-off to Copilot (or the Copilot command line, if allowed). The commands, not the agent, hold the loop's state, run the checks and decide what comes next and when a loop ends, so the result doesn't depend on which assistant ran it. Headless Claude Code runs the same prompts during development, on public repos and the author's own repo only.
9. **The organisation's data stays at the organisation.** Repo types, skills, answers, specs and learning examples created at an organisation live in its metarepo only, never in the Atticus repo. Atticus ships generic, invented examples.

## 4. Target state

### 4.1 Scanning: AI → deterministic → AI (ADR 0074)

For each repo:

1. **Identify.** The AI surveys the repo and matches it against the organisation's known **repo types** by fingerprint (build files, dependencies and house packages, framework markers, layout), and confirms. Clear match: reuse. Partial: reuse and extend. None: a new type. A real tie: ask.
2. **Customise the scanner, as a change.** The lightest thing that works: a rule file (dialect, framework model, reader override) when the rule format can express it; otherwise a scanner plugin in code, developed as a reviewed change (spec, golden tests, critic, merged PR), loaded only then, sandboxed (read-only files, no network, time and memory limits), versioned and pinned.
3. **Run** the scanner with that configuration, the built-in readers as a fast path.
4. **Verify.** The AI compares the result with its own reading; the citation check runs; disagreements go back to step 2. Agreement between the AI and a built-in reader confirms; disagreement is a finding.
5. **Stop at ambiguity as a question**, with options and evidence, and a proposed scope: this repo only, or every repo of this type. The person answers and confirms the scope in the app; the app writes the answer to a file (a decision for this repo, or a change to the repo type's skill, which goes through a PR) and shows the rerun command; the rerun reads it; an answered question is not asked again.

The output is the catalog (C1, per commit) and the input to the repo spec (4.2). Repo types, skills and decisions accumulate in the organisation's metarepo as its own learned scanner; later repos of a known type need fewer questions, and that is measured.

### 4.2 The repo spec: flows

The lowest grain Atticus captures is the **flow**: what happens, in order, when something enters the repo, and what data moves and changes on the way, as a person would draw it on a whiteboard, with evidence behind each step. It is not a code tree.

Example, an orchestration API: a vendor calls it through the external gateway; it does two lookups against another vendor; writes an audit log entry; transforms some fields for the next call; publishes an event; calls two APIs on another service through the internal gateway; then updates the database and responds. In a UI repo the trigger is a page load or a button click, then the BFF's API, then another repo's API through the internal gateway.

**A flow records:**

- **Trigger:** endpoint, page or action, listener, job or schedule; the caller and the route in (which gateway).
- **Steps, in order:** lookup, call out (to whom, sync or async, through what), transform (which fields become which), validate or branch (condition and outcomes), log or audit, publish, read or write a store (which table or collection, which fields), respond. Loops, retries, error paths and compensation are steps too.
- **Data:** the inputs and outputs of each step at field level, so a field can be followed through each transformation.
- **Links to the catalog:** each step names the catalog records it touches, so structure and behaviour are one model.
- **Evidence** per step, and who confirmed it (principle 2).

**How a spec is built:**

1. **A spec template per repo type.** For a new type the AI drafts what a complete spec of that type holds: which triggers exist (an orchestration API has endpoints and listeners; a UI has pages and actions; a batch repo has jobs), which step kinds occur, what each must record, and which flows form a family (a set of plain create, read, update and delete endpoints is one family with its variations, not twenty flows). The template and the first repo's spec are reviewed in one PR; until it merges, that spec is marked "template not yet reviewed". Later repos of the type reuse the merged template.
2. **Fill.** The AI writes one flow (or family) per trigger until every trigger has one.
3. **Critic.** It checks the spec against the template and the code: a trigger with no flow, a step with no evidence, a call out with no target, a field that appears from nowhere, a write with no fields, an error path not covered, a step that contradicts the catalog. Each finding goes back to step 2 or, per principle 4, becomes a question with the rerun command shown.
4. **Review.** A person reviews the spec's PR; their corrections are captured for learning (4.7).

**The estate pass** then matches each repo's calls out to the other repos' triggers (through gateways and topics), so a flow continues from a button click through the BFF and the internal gateway into the orchestration API and on to its database. A join needs a citation at both ends. It also detects **features**: groups of flows, within and across repos, that serve one business purpose, named in business language with the flows as their evidence.

### 4.3 Knowledge sources: tagged, synced, scanned, queryable

Code says what the estate does; wikis and documents say how the organisation works.

- **Tagged when connected.** Each source (wiki space, knowledge repo, document folder, diagrams, API specs, a vendor's online docs) is tagged by framework (for example the in-house service framework or the UI framework), by kind (enterprise architecture, integration patterns, platform runbooks, security standards, change process) and by owner. Tags are free text with suggestions, stored in the source's file, editable in the app.
- **Synced, then scanned.** A sync command fetches each source to a dated local snapshot (knowledge repos are cloned to `knowledge-repos/`); the scan reads only the snapshot. It runs the same AI → check → AI loop, guided by the tags, and extracts into the existing kinds, extended as needed (section 5):
  - **Integration patterns:** which applies when (synchronous through the internal gateway, events through the broker, file transfer, a vendor through the external gateway) and their rules.
  - **Frameworks and standards:** how a service on a framework must be built; logging, audit, security and data handling rules.
  - **Processes and requests:** every process a change can trigger, wherever it is defined: change tasks, service requests (a firewall rule, a certificate, a queue, database access, a DNS entry, a service account), approvals and boards, each with when it applies, lead time, who handles it, the form or catalogue item, and the inputs it needs.
  - **Decisions and constraints:** what is mandated, banned or being retired.
- **Evidence and freshness.** Every item quotes its page or file and section with the snapshot date; a changed page is re-read on the next sync; items from two sources that disagree are flagged; a document never overrides a fact verified from code.
- **Queryable** in the app (search and filters by tag) and by command (`atticus knowledge ask`, `atticus knowledge list --tag …`), and through the MCP server for agents.
- **Used when planning.** In the architecture and stories stages the agent checks each changed step against the patterns, standards and processes: a new call to a vendor suggests the firewall request and the vendor onboarding process; a new queue suggests its request; a new column holding personal data suggests the data classification review; a pattern the design breaks is a finding. Each suggestion cites its source and the flow step that triggers it, and becomes a task or a finding the person accepts, edits or drops. Accepted ones appear with their citations on the Tasks screen.

### 4.4 The change lifecycle: three stages, one loop

| Stage             | Input                                        | The AI produces                                                                                                                                                                                                                                                                | Done when                                                       |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Feature           | A brief, existing stories, or a Figma design | The feature placed against the estate: the features and flows it touches, found by the model from a compact index of the specs (every id checked); high-level gaps, conflicts with changes in flight, questions                                                                | No blocking findings or open questions; the feature PR approved |
| Architecture      | The approved feature                         | **Target flows**: for every flow touched, the steps added, changed or removed, with fields; new flows; interface and data changes; patterns and standards checked; spec deltas                                                                                                 | The same; the architecture PR approved                          |
| Stories and tasks | The approved architecture                    | Stories per repo derived from the flow deltas; tasks per changed step, each with acceptance criteria, the fields and evidence it touches, and the prompt to implement it in Copilot or Claude Code; the change tasks and service requests it needs, from the knowledge sources | The same; the stories PR approved                               |

In every stage each finding comes with options and room for a comment; the person picks or comments in the app; the app writes the choice into the change's files and shows the command to re-run the stage; the critic runs in every iteration; loops end per principle 4.

Entry points: a brief (the model places it by meaning, not words); existing stories (read and mapped to flows, gaps flagged); or a Figma design (screens, fields and actions read from an exported file and mapped to UI flows; fields with no backing are gaps).

### 4.5 The app

An editor and visualiser of the metarepo's files. Every page shows the command to run next (terminal, Copilot or Claude Code) and refreshes when files change. Six screens follow the work; every other page stays under **More** until reviewed.

1. **Dashboard:** what is onboarded and scanned (with coverage), changes in flight and their stage, open questions from everywhere, and search across specs, flows and knowledge.
2. **Onboarding:** the organisation's repos (from the file `atticus repos list` writes), filtered and selected; knowledge sources connected and tagged; the commands to clone, sync and run the full scan; then scan results, questions (each answer written to a file, with the rerun command), scan review, repo specs to review, and the commands for later scans.
3. **Feature design:** the feature stage.
4. **Architecture:** the diagram workspace (4.6), opening on the current state or a change's feature view, and the architecture stage.
5. **Stories:** the stories stage.
6. **Tasks:** per repo, each task with its prompt to copy and the cited process and request tasks; status read from local files and branches (`task/<change-id>/<task-id>`).

Every screen has empty, loading and error states, words from the copy file, and passes WCAG 2.1 AA. Pages under More that today call the server's job, scan or AI endpoints switch to showing the command when those endpoints go; any that can't are listed in Phase 4 as dropped.

### 4.6 The diagram workspace (the flagship)

One full-page, interactive model of the estate that people explore, compare, rearrange and correct, from the whole estate down to one step of one flow.

**Model.** One graph served by the local API, in two linked hierarchies:

- **Structure:** estate → domain or system → repo → component or module → element (endpoint, page, listener, job, client, entity, table, column, topic, field).
- **Behaviour:** repo → flow (or family) → step, each step linked to the elements it touches, and flows joined across repos by the estate pass.

Typed edges: calls (sync, async), through a gateway, builds on, reads, writes, publishes, subscribes, deployed to, runs on, provisions, field maps to; between steps: next, on branch, on error, on retry, with the data passed (which fields, how transformed). Every node and edge carries evidence, who confirmed it, state (current, new, changed, retired) and gap flags. Deeper levels load as they open.

**Lenses on the same model:**

- **Architecture:** context, container, component.
- **Repo:** one repo as the canvas: triggers on one side, exits (calls out, stores, topics, vendors) on the other, its flows between.
- **Flow:** one flow, or a feature's flows, as a sequence or a step diagram in swimlanes per repo, with the data at each step and how fields change. Error paths and retries shown or hidden. A step that calls another repo opens that repo's flow in place, so one view follows a button click to the database.
- **Data:** stores, tables and columns, who reads and writes them, field lineage from screen field to column.
- **Integration:** synchronous and asynchronous links, gateways, topics and queues, vendors.
- **Infrastructure and deployment:** environments, platforms and clusters, cloud resources from Terraform, Helm and Kustomize, pipelines and what deploys where.

**Navigation.** Pan and zoom; semantic zoom (detail changes with zoom level); open a node in place or drill in with breadcrumbs; collapse and expand; minimap; search that jumps and highlights; focus on a node's neighbourhood; path finder (how does A reach B; where does this field go).

**Current and feature views.** A current-state view and one per feature. A feature view shows what has to change against the current state, or against another feature's start or target: added, changed, retired, and missing or unproven (red), each with an icon or pattern as well as colour. An impact overlay shows what a change to a node reaches.

**Gaps and correction in place.** Red marks the feature's gaps; inside a repo or flow the view lists exactly what is missing (the field mapping, the step, the endpoint). Clicking a gap opens its question with the AI's options; the answer is written to the change's files and the rerun command shown. Wrong nodes, edges, steps and mappings are corrected on the canvas the same way; every correction is a file and feeds learning.

**Legible on first render.** A tangle is a failure, not a starting point.

- The layout suits the lens: layered left-to-right for flows and calls, top-down for context, swimlanes per repo for a cross-repo flow, sequence for steps over time, grouped grids for infrastructure.
- Beyond a readable number of nodes the view groups automatically (by repo, domain or layer) with counts; repeated edges merge with a count; minor steps (logging, config reads) fold into their neighbour unless asked for.
- Orthogonal routing with few crossings, bundled parallel edges, labels that never overlap, text sized to zoom, long names shortened with the full name on hover.
- Each view's layout is scored (crossings, overlaps, edge length, nodes on screen) against limits set in the Phase 1 spike; a view over the limits regroups before it is shown.

**Rearranging by hand.** Drag boxes and groups with edges rerouting live; pin boxes and "tidy up" around them; align, distribute, group, resize, collapse; undo, redo and reset. The arrangement is saved per view and per feature view as a file in the metarepo, shared through git, and survives a rescan: new nodes are placed near their neighbours without moving what the person arranged.

**Inspector.** For the selected node, edge or step: properties, evidence with a link that opens the file at the line in the editor, who confirmed it, its fields, and the features, changes and questions it belongs to.

**Performance.** Layout runs in a web worker; the page never freezes. Node counts for a smooth overview and a detailed view are set from the spike and tested.

**Accessibility.** Full keyboard navigation; an outline and table view of the same graph for screen readers; colour never the only signal.

**Export.** SVG, PNG and Mermaid per view; draw.io later (4.9).

**Technology (proposed; proven by the Phase 1 spike, licences checked against the bank's policy).** React Flow (xyflow, MIT) for the canvas, nested groups, minimap and controls; ELK.js (EPL-2.0) for layered layout with nested groups and orthogonal routing, dagre (MIT) as the fallback; a WebGL renderer (sigma.js with graphology, MIT) later if overviews outgrow it. All bundled offline.

### 4.7 Learning

Every correction is captured as drafted vs merged: a scan answer, a spec edit, a stage answer, a diagram correction. Corrections are fed back as examples in later drafts, measured as a correction rate per stage and per repo type, and proposed as rules (dialects, template entries, critic rules, skills) when they repeat; each proposal is a change a person approves. All of it stays in the organisation's metarepo (principle 9).

### 4.8 Atticus with Copilot

Everything runs from `atticus` commands (principle 8). Copilot is where the AI part of a command runs at the bank, in this order of what needs no permission first:

1. **Hand-off from the command.** The command writes the prompt and context into the run folder and prints the line to give Copilot in agent mode, in either editor. Copilot reads the repo, may run further `atticus` commands the prompt names, writes the result file and stops at a question. `atticus handoff done <run>` checks the result; `atticus next` says what the loop needs now. Nothing is maintained by hand: any prompt files or Copilot instructions the metarepo needs are written by `atticus` commands.
2. **The Copilot command line**, if the bank allows it (not known yet): a headless runtime like headless Claude Code, so `atticus` runs the prompt itself and a person only answers questions.
3. **An MCP server**, if the bank allows MCP in Copilot (not known yet): the specs, flows, catalog and knowledge queried directly instead of through commands.
4. **A thin extension** (`@atticus` in Copilot Chat), if the bank allows installing one (not known yet).

The app shows, on every page, the command to run, and for a hand-off the line to give Copilot.

### 4.9 Later, not now

The path finder across the whole estate, a WebGL overview, draw.io export and reconcile against drawn diagrams, and choosing a different layout automatically. They follow once the Phase 4 views are in use.

## 5. Contract changes this plan needs

Each needs an ADR, a schema version bump and a migration (rule 1), drafted in the phase that first needs it. Existing kinds are extended rather than duplicated.

| Contract | Change                                                                                                                                                                                                                                                                                                                                                   | Phase  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1       | New `Flow` record (trigger, steps, data, links to catalog records, evidence, who confirmed); fields on interface, event and UI records                                                                                                                                                                                                                   | 2b     |
| C1       | `Pattern` extended for integration patterns and standards (applies-when, rules, quoted source and snapshot date); a new `ProcessDefinition` kind for request and process types (applies-when, lead time, handler, catalogue item, inputs), while `ProcessArtifact` stays the instance suggested or raised for a change; `Decision` for mandates and bans | 3      |
| C1       | `OwnerQuestion` and `Unresolved` reused for every question (scan, spec, stage, diagram), with options, scope (repo or repo type) and the rerun command; `owner` and `channel` made optional, states become open, answered and retired; renamed if "owner" misleads                                                                                       | 2a     |
| C6       | Answers and decisions as metarepo files (people's words, not generated catalog)                                                                                                                                                                                                                                                                          | 2a     |
| C6       | Repo types at `repo-types/<id>/` (fingerprint, scanner configuration, spec template), distinct from today's platform `profiles/`; their skills in the existing `process/skills/<id>/SKILL.md` format                                                                                                                                                     | 2a, 2b |
| C6       | Knowledge sources with tags; layout files per view                                                                                                                                                                                                                                                                                                       | 3, 4   |
| C6       | `roles.yaml` and its role schemas (deprecated by ADR 0073) removed                                                                                                                                                                                                                                                                                       | 4      |
| C4       | Questions API                                                                                                                                                                                                                                                                                                                                            | 2a     |
| C4       | Hierarchical graph API (structure, behaviour, overlays, lazy children); the server shrinks to files and the catalog                                                                                                                                                                                                                                      | 4      |
| C4       | Scanner plugin loader and sandbox                                                                                                                                                                                                                                                                                                                        | 2a     |
| C5       | Iteration loop with finding fingerprints and the end rule of principle 4                                                                                                                                                                                                                                                                                 | 2a     |

CLAUDE.md rule 4 and ADR 0074 are reworded with principles 2 and 3: every fact cites file and line, a deterministic check confirms what it can and the record shows who confirmed the rest; the same commit, org pack and answers return the stored catalog.

## 6. The plan

Each exit is checked by running the real flow on real repos, not by tests alone, and reported as works / partial / not built. Targets marked "proposed" are confirmed after the Phase 1 baseline (decision 6). Phases 3 and 4 overlap once the graph API, Phase 4's first item, is fixed.

### Phase 0: stabilise, decide, get a model

- Fix the CLI test hang, the performance budgets and the always-changed rescan (A1–A3); full test run (A4); push (A5); CI checked on the hosted runners.
- Done: the CLAUDE.md rule 4 change, ADR 0074 and this plan committed (74aa779).
- A development model: the author's own Claude Code and API key, on public repos, invented fixtures and the author's own repo only. The first direct call through the AI runtime.
- The bank's answers so far (from the product owner, 2026-10-21): GitHub Copilot in IntelliJ IDEA and VS Code is allowed; no model API a tool could call by itself; installing through npm is likely. Not known yet: MCP in Copilot, installing an extension, the diagram libraries' licences. The open ones are listed in `docs/plan/bank-questions.md` for the product owner to answer.
- Freeze new features outside this plan.
- **Exit:** green locally and on CI, pushed; a live model call made through the runtime; the bank's answers recorded.

### Phase 1: measure, and prove the diagram stack

- **Code bench:** 20–30 public repos across stacks, weighted to a bank's (Spring and Java, ASP.NET Core, legacy .NET and WCF, Angular and React, Node BFFs, Python, Terraform, Helm, pipelines), each with a hand-checked reference of what it serves, calls, stores and deploys (I2). At least two repos of the same type. Five forming a small connected estate also get hand-written reference flows.
- **Knowledge bench:** an invented Forge knowledge corpus (integration patterns, standards, service-request and change-task pages, conflicting pages) with reference extractions.
- **Design bench:** an invented Figma export for one UI repo of the connected estate, for Phase 5.
- **Scorer:** found, missed and wrong per repo and kind; flow coverage and step accuracy; join accuracy; knowledge extraction accuracy; scan time and model cost; a draft-quality score for changes (H3).
- **Diagram spike:** in a throwaway page, React Flow and ELK.js draw NadiEngine's catalog and the reference flows of the connected estate in swimlanes; dragging, nesting, a large overview and keyboard use tried; layout score limits and node counts set from it.
- **Exit:** baseline numbers for today's readers; the diagram stack chosen with evidence and its limits set.

### Phase 2a: the AI-first scan

- The scan loop of 4.1 (I9), the plugin loader and sandbox (I13), repo types with fingerprints and reuse (I10), questions with scope and answers as files, finding fingerprints and the end rule, the citation check, per-commit results and changed-file invalidation (I5), reader overrides (I6), coverage (I7).
- A minimal Questions page in the app (list, options, answer written to a file, rerun command), folded into Onboarding in Phase 4.
- Prototype on NadiEngine, compared with today's catalog (I3); then the code bench.
- **Exit (proposed):** on the code bench's catalog facts, wrong at most 5% and below today's readers, missed below today's; the second repo of a type needs fewer questions than the first; on NadiEngine, a short list of real questions, each answered in the app and picked up by the rerun; the scan of one public repo also run start to finish with `atticus` commands and their hand-offs to Copilot agent mode, in VS Code and in IntelliJ IDEA, with the same catalog as the headless run; at least one bench repo needs an AI-written plugin, which lands as a reviewed PR with golden tests; a plugin that tries to write files, reach the network or overrun its time or memory is blocked (tested).

### Phase 2b: repo specs of flows

- Spec templates per repo type, flows and families filled and iterated with the critic, PR review (4.2, I11), interface and field level (D4).
- **Exit (proposed):** at least 90% of triggers on the bench have a flow; on the reference flows at least 90% of steps correct and no step without evidence; NadiEngine's spec approved by its author after review.

### Phase 3: the estate and knowledge

- The estate pass: flows joined across repos, field lineage end to end (D11), features detected and named in business language (I12, B3).
- Knowledge sources: tags, sync to snapshots, the knowledge scan and queries by command and in the app (4.3); agents reach them through the MCP server in Phase 6.
- **Exit (proposed):** on the connected estate, at least 90% of joins correct and none without a citation at both ends; a field followed from a screen to its column on the reference flows; on the knowledge bench, at least 90% of items extracted with correct quotes, conflicts flagged, and questions answered correctly by `atticus knowledge ask`.

### Phase 4: the app and the diagram workspace

- The graph API (structure, behaviour, overlays, lazy children) fixed first.
- The six screens and More (B1); the app becomes editor, visualiser and command; `atticus repos list`; the server shrinks to files and the catalog; More pages reviewed (keep, fold in, drop); `roles.yaml` removed.
- The diagram workspace of 4.6 (F3): the architecture, repo and flow lenses.
- **Exit:** onboarding → scan questions → repo spec review → current-state diagram done on NadiEngine and the connected estate entirely through the app and copied commands; the diagram explored from estate to a single step in the architecture, repo and flow lenses; every view within the spike's layout limits on first render; a rearranged view kept across a rescan; keyboard-only and screen-reader checks passed.

### Phase 5: the change lifecycle

- The three stages of 4.4 (B10) with the critic in every iteration and the end rule; entries from a brief, existing stories or Figma (B7–B9); target flows and the feature view on the diagram; tasks with prompts; processes and requests suggested from knowledge with citations; the data, integration and infrastructure lenses.
- **Exit:** two changes go from feature to tasks with no hand-editing beyond answers: on NadiEngine, "let a chat member export the chat's messages" (already drafted in the author's metarepo), and one started from a design on the connected estate. Both are scored against a written rubric agreed before the run (correct flows touched, every changed step has a task, fields named, required requests found with citations, no invented facts), and the feature view shows each change's gaps. On the canvas, a wrong edge and a missing field mapping are corrected, each written as a file and picked up by the rerun; one feature view is compared with the other feature's target; the data, integration and infrastructure lenses show the connected estate within the layout limits.

### Phase 6: learning and the assistant

- Corrections captured, fed back, measured and proposed as rules (4.7, H1–H4).
- `atticus next` and hand-offs to Copilot for every loop, in both editors (4.8, H5); a Copilot command-line runtime, the MCP server and the extension only if the bank allows them.
- **Exit (proposed):** across five changes listed before the phase starts, on the connected estate and corrected by the author, the correction rate per stage (corrected lines over drafted lines) falls by at least a third from the first to the last; the stories stage runs from `atticus` commands with hand-offs to Copilot agent mode in VS Code and IntelliJ IDEA.

### Phase 7: on-site pilot

- At the bank, on a handful of repos, with Copilot in the person's editor and all data in the bank's own metarepo (principle 9): onboarding, scan, specs, one change to tasks.
- **Exit:** the bank's people judge the specs and one change's output against the Phase 5 rubric; what fails becomes work in the earlier phases' areas.

### Phase 8: bank readiness

- Packaging and signing, dependency scanning, local server hardening (G5); the ADO workflow (G6); published to the bank's internal npm registry with Node 22 on laptops (or a packaged runtime if not); the hand-offs checked in both editors; the security review; guides.
- **Exit:** installed on a target laptop; `atticus doctor` green; the security review's questions answered.

## 7. Not in scope

- Atticus never raises change tasks or service requests, pushes to protected branches, deploys, or connects to live databases, consoles or monitoring (rule 6). It suggests and drafts; a person acts.
- It does not run or test the organisation's code; flows are read from code and documents.
- It does not replace the Git host's review rules: who may merge is the host's setting.
- The app does not run scans, AI, git or calls to external systems.

## 8. What gets retired or demoted

- **Built-in readers** become a fast path and a cross-check, not the gatekeeper.
- **Role leftovers:** `roles.yaml` and its schemas (deprecated by ADR 0073) and Atticus's own "the author of a PR can't approve it" check, left to the Git host (decision 5).
- **The local server's job running, scan endpoints and AI calls**, once the six screens and the More pages kept don't need them.
- **The 21 pages under More**, reviewed one by one in Phase 4: keep, fold into the six, or drop. First to examine: initiatives, learning lessons, release views, service desk queue, governance, AI quality, test trace.
- **Commands and packages** used only by dropped pages.

## 9. Risks

| Risk                                                                                                  | Mitigation                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model invents facts                                                                               | Citation check where it applies (principle 2), the AI pass, the critic and review; who confirmed each item is shown                                               |
| A whole estate is slow or costly to scan (one flow per trigger, thousands of triggers)                | Flow families, repo type and template reuse, per-commit storage, changed-file invalidation; time and cost measured from Phase 1; budgets can be switched on later |
| Bank code sent to a model provider                                                                    | Only through Copilot, which the bank allows; Atticus itself calls no model at the bank                                                                            |
| The organisation's data reaches the Atticus repo                                                      | Principle 9; the deny-list in CI; Atticus ships only invented examples                                                                                            |
| Ingested text tries to instruct the AI                                                                | Quoted as data, never instructions; the critic flags it; plugins sandboxed with no network                                                                        |
| AI-written plugins misbehave                                                                          | Reviewed changes with golden tests, sandboxed, pinned, re-tested before each use                                                                                  |
| Everything runs through a person in Copilot, so a whole estate's first scan needs many agent sessions | One prompt covers a repo's whole loop; repo types and templates cut later repos' work; the bench measures sessions and time per repo                              |
| Copilot's agent mode differs between VS Code and IntelliJ IDEA, or between model versions             | The commands hold the loop's state and checks (principle 8); the Phase 2a exit runs in both editors                                                               |
| MCP, an extension or the Copilot command line isn't allowed                                           | None is needed: the commands and their hand-offs work without them                                                                                                |
| Diagram libraries fail the licence policy or the quality bar                                          | Phase 1 spike; dagre as the layout fallback; judged by users with layout scores                                                                                   |
| Accuracy shown on repos unlike the bank's                                                             | The bench weighted to a bank's stacks with a connected estate; the on-site pilot before readiness                                                                 |
| Loops that never finish                                                                               | Finding fingerprints and the end rule (principle 4)                                                                                                               |
| Scope creep again                                                                                     | This plan is the order of work; anything not in it waits; every phase has an exit on real code                                                                    |

## 10. Decisions needed from the product owner

1. Done: rule 4, ADR 0074 and this plan adopted (2026-10-21).
2. The diagram stack after the Phase 1 spike, and its licences against the bank's policy.
3. Done: at the bank, Copilot in IntelliJ IDEA and VS Code; headless Claude Code for development only.
4. The bench's repo list (public repos only), including two of one type and the five with reference flows.
5. Drop Atticus's own "author can't approve" check, leaving it to the Git host.
6. The proposed targets, after the Phase 1 baseline.
