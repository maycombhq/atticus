# 0191. A change goes product owner → architect → business analyst → tech lead: questions by what they ask, the BA shapes the stories, knowledge answers

- Status: accepted (decisions A and B by the product owner, 2026-11-09; the rest built from the app-only audit of the roles)
- Date: 2026-11-09
- Builds on: ADR 0073 (no roles in the app: words, not permissions), ADR 0078 (questions as files), ADR 0083 and 0122 (knowledge sources, inputs/), ADR 0140 (questions routed to their owner, roles.yaml teams), ADR 0181 part 4 (role-owned questions, owners on a change), ADR 0186 (writes to shared systems need the page's confirmation), review round 50 (stable story and task numbers)
- Contracts: C6 question file version 6 (two optional fields, `asks` and `routed`; the draft's `asks`), C6 `roles.yaml` version 3 (a team's optional `roles`, the file's optional `defaults`), C4 local API 3.6.0 (additive). Migrations in `atticus upgrade`: `questions-v3` writes version 6, `roles-v2` writes version 3 (both only the number; the ids are kept as first shipped). Planner state (not a frozen contract): `stage/stories-shape.yaml` version 1. No C1, C2, C3, C5 or `change.yaml` change.

## Context

The owner's intent: a change flows product owner → architect → business analyst → tech lead, each answering questions at their own level; nobody faces 200 questions or the same one twice; what the organisation's wikis know is suggested for every change and task and can be asked instead of searching Azure DevOps; ADO and ServiceNow steps appear as manual instructions; the product owner and the business analyst use the app.

An audit that used only the app found:

1. A business question ("What happens when the account has too little money on the day?") was tagged _For the architect_ because the feature stage asked it (ADR 0181 gives the stage's role). Running the critic from the brief page made design findings (circuit breakers, alerts); Home then showed the product owner "BLOCKED · IN DEFINE" with three blocking findings while the brief's gate said _Ready to raise_.
2. A new change's owners were empty but for its creator, so Home asked "Pick a role".
3. Hand-off reviewers were never named ("### Reviewers - None"), and At a glance said what the change waited on, never who.
4. "Ask team-portal" only recorded that the gap was asked; asking happened outside Atticus.
5. With a manual work tracker (ADO), nothing at Plan ready put the stories and tasks in the tracker.
6. A change's suggested knowledge items were paths (`inputs/wiki/snow-firewall-request.md#…`); Ask Atticus searched only the catalog ("No record in the catalog is named…" for "How do I request a firewall rule?"); Knowledge › Search said "No source has a snapshot yet" while inputs/ files were being suggested.
7. The brief was a raw Markdown box full of `<!-- … -->` under its file path; product owner and business analyst screens used jargon (AI lens, story bar, knowledge gap, "Apply puts it in the map").
8. Home showed everyone the same list: the product owner saw the set-up checklist, upgrades and the estate's checks.
9. Small: the brief wasn't a tab ("Write the brief on Feature brief" pointed under More pages); "Name its repos on its brief" pointed nowhere; the question filter listed the change's id as a repo; the change page had two Save buttons.

## Decision

### A. Questions are routed by what they ask

- **What it asks.** The AI tags each question it raises `asks: business | design | delivery` (the feature and small stages' formats ask for it). Business is what the change must do for whom (a rule, a limit, what happens to the customer or the money); design is how the estate does it (a call, a timeout, a topic, a circuit breaker); delivery is how and when it is built and shipped.
- **Who answers.** Business → the product owner, or the business analyst once the stories are written (a question the stories or tasks stage raises); design → the architect; delivery → the tech lead (`roleOfAsks`). A draft's own `role` still wins; a question with no `asks` keeps its stage's role, as before.
- **A person re-routes.** `POST /api/questions/{id}/route { role }`, the Questions page's _Send it to_, and `atticus questions route <id> --to <role>` set `role` and record `routed: { from, by, at }`. The answer, if any, stays.
- **Findings by level, too.** Each finding the API lists carries `asks` (`asksOfFinding`: the design's files are design; tasks, build and release delivery; a finding on the brief, proposal, UX or stories is business unless its rule, lens or words are about how the estate does it: resilience, timeouts, alerts, interfaces). Home shows a product owner or business analyst only the business ones (and says how many design findings wait for the architect), and a finding holds a change only at its phase's levels (`asksOfPhase`): in Define only business findings make it BLOCKED, so Home and the brief's gate agree. C3 is unchanged: the level is worked out on read.

### B. The business analyst shapes, the AI re-checks

- The stories stay worked out from the target flows, one per repo and flow (round 50's numbers kept). The business analyst can **rename**, **split**, **merge** (stories of one repo) or **add** a story in plain words, on the Stories tab (`POST /api/changes/{changeId}/stories/shape`). Each is kept in `stage/stories-shape.yaml` (Atticus's state; it rides with the hand-off).
- **Numbers.** A rename keeps the story's number; a merge keeps the first story's; a split's first part keeps it and each other part takes the next free number; an added story takes the next free number. New numbers are reserved in `stage/stories-numbers.yaml` when the shaping is recorded, so they never move or get reused. A task moved to another story takes that story's next free task number, kept in the shape file (`labels`).
- **The AI maps the tasks.** The next draft of the stories gets the shaping as data (and one rule: title each named story with its name, put each task under the story it belongs to, never add or drop a task). The draft's answer, listing a task under another story the shaping touched, is the mapping; Atticus keeps it (`assigned`) so every later read (the task's context, the stories bench, `rewriteStories`) has the same stories. A stage with no shaping builds exactly the prompt it built before.
- **Nothing left uncovered.** The stage's check refuses a story the analyst named that has no task (`stories.shape-uncovered`); the critic's `tasks-cover-stories` at the plan gate checks stories.md against tasks.md as before. A shaping no draft applied yet can be taken back.
- Limits: a story is one repo's work, so merges across repos are refused and a task moves only between stories of its repo; the small change's single stage doesn't read the shaping.

### C. Owners, reviewers, and who it waits on

- **Suggested owners.** `roles.yaml` version 3 says who takes each role: a team's `roles` (for changes on that team's repos) and the file's `defaults`. `GET /api/changes/{changeId}/owners/suggested` lists them for the roles a change doesn't name; the change page shows each with **Accept** (one click writes change.yaml's owners through the change store). Nothing is written by itself.
- **Reviewers.** A hand-off's reviewers are CODEOWNERS of its files plus the next role's owners on the change (define → the architect, design → the business analyst, plan → the tech lead; `nextOwnersOf`). The PR body names them with their role, or says whom to name.
- **Told.** Raising the hand-off tells those reviewers through the notify adapter (manual: a step for the person to tell them); the hand-off's own confirmation covers it.
- **Waits on.** The cockpit's `waitsOn` names who the change waits on now: the next role's reviewers of an open hand-off, else the phase's role (the business analyst in Plan until the stories are done, then the tech lead). At a glance says "Waits on: @ari (architect)", or that nobody is named.

### D. Owner questions sent

`POST /api/owner-questions/{id}/send` posts an owner question through the notify adapter, on the person's `owner-ask` confirmation (a message, ADR 0186); manual notifications make it a step; with none set, it says to copy the text and ask, as before. The Questions page's owner questions get **Send to <owner>**; a critic gap asked with Ask is listed there.

### E. Work items

`GET /api/changes/{changeId}/work-items` lists the feature, each story and its tasks as `atticus ado sync` would write them, with what `sync.yaml` remembers; `POST` writes them: with a manual tracker a step each (Home › Manual steps, with title, description, acceptance criteria and parent to copy, and the id to record), with a live tracker on the person's `work-items` confirmation. The ids are kept in `sync.yaml` under each story's and task's stable key, so a later sync updates rather than duplicates (the same `syncWorkItems` code path as `atticus ado sync`). The Stories tab shows them, each with its standing.

### F. Knowledge, opened and asked

- A change's suggested knowledge carries `passage`: a section's own text with its page and heading, or an item's quote, opened in place (**Read it here**); the id is behind Details. `GET /api/knowledge/passage?id=` opens any section by its id.
- `GET /api/ask` answers from knowledge too (`knowledge`): the knowledge items whose words the question shares, each with its quote, and the passages of the wikis' snapshots and inputs/ files (inputs/ read as it is when it has no snapshot), each cited. No AI words an answer here; the step that does (`atticus knowledge ask`) is offered.
- `GET /api/knowledge/search` searches inputs/ as it is when inputs has no snapshot yet.

### G. Plain words, and Home by role

- The brief is a tab of a change and a form: one box per section of brief.md with the section's comment as its hint; Save writes the same brief.md (an untouched section byte for byte). File paths go behind Details on the brief and on artifacts; findings show the review question in words ("Is it complete?"), not the lens's id or the rule's; jargon on the product owner's and business analyst's screens is replaced (the Words panel keeps the terms).
- Home, for a product owner or business analyst (their roles from the change's owners, else their pick), shows **Your changes** with whom each waits on, and folds the set-up material (how steps run, the set-up checklist, upgrades, the estate's checks) under _Setting up Atticus_. Everyone else sees Home as before.
- The owners form opens on _Change who is on it_, so the change page has one Save at a time; the question filter's repos leave out change ids; a change's repos include its target flows' (the cockpit no longer asks to name repos on the brief).

## Consequences

- A business question raised by a design stage reaches the product owner, and one a person moves stays moved. A design finding no longer makes the product owner's change look blocked in Define.
- The business analyst decides the stories' shape in words; the numbers stay stable; the AI maps the tasks and is checked for coverage. A shaping can be wrong (an added story no step does): the stage stops with it, for the architect to add the steps or the analyst to merge or take it back.
- Hand-offs have named reviewers and At a glance names who it waits on, which needs owners on the change: suggestions make that one click.
- The ADO and ServiceNow steps are manual instructions with the fields to copy; the ids come back on the steps and are kept, so nothing is created twice.
- Ask answers "how do I…" from the organisation's own pages, cited, without a model.
- Teams with no roles.yaml version 3 see no suggestions, and the app says what to add.
