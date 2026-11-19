# 0201. The quick path, and personas that ask the map

- Status: accepted (2026-11-18, by the owner, with: the quick path recognised by a type's shape; a new repo marked `newRepo: true` at the feature stage; the staged path's hint starts a new change; a manifest or planned consumer is a note on the staged path in this slice)
- Date: 2026-11-18
- Amended: 2026-11-18, by the owner and after the review of the map tools and personas: see [the amendment](#amendment-2026-11-18-after-the-review-of-the-map-tools-and-personas) at the end. The decision above it stands as it was accepted.
- Release: 2.0.0-beta.30, slice 1 (steps 0 to 5 of [the plan](../plan/v30.md))
- Amends: ADR 0087 (the stage loop's end rule), ADR 0189 (point 9, planned components)
- Extends: ADR 0006 (OpenSpec is the foundation), ADR 0104 (the map tools), ADR 0113 (change types, the fast path), ADR 0177 (skills and agents from one source)
- Contracts: C4, additive only: the map tools gain `conflicts` and three changed answers, and the local API 3.18.0 gains `quickPath` on a change. C6, additive only: one more built-in change type and starter files in folders ADR 0177 already made; no schema changes, so no version bump. C1, C2, C3, C5 and the facts file are unchanged. No migration; two upgrade steps add files and one list entry.

## Context

Three kinds of change were tried by hand on the Forge estate at 2.0.0-beta.28.5: a new product no repo holds, a move of services to another platform, and a new event to an existing hub. The stages refused the first two and gave the third 19 story problems. The same three changes written by hand as proposal, spec deltas, design and tasks, with no stage file, went through the critic, the hand-off and to a prepared task run.

So a second path exists already and has no name. Other teams reach an OpenSpec change from a free-form requirements file and a few role personas, each with a naysayer (a second persona whose only job is to ask what the first got wrong). They have no map. Atticus has the map and no personas.

This ADR names the path, gives it one check at its door, ships the personas, and makes the staged path say where to go when it can't express a change.

## How it is today

Read in the code at beta.28.5.

- **Change types.** `DEFAULT_CHANGE_TYPES` (`packages/core/src/orgpack-defaults.ts:25`) has seven types; none is plan, build, release with proposal, specs, design and tasks. `ChangeType` is a strict object (`packages/core/src/schema/orgpack.ts:235`): an unknown key is refused, which is why ADR 0113's three keys needed version 2 (`orgpack.ts:312`, `:314`).
- **What is next.** `stageOf` maps a state to a stage and nothing else (`packages/cli/src/next-commands.ts:892`; the app's copy, `packages/ui/src/screens/work/next.ts:104`). A change in `plan` with no stage file is offered `atticus plan stories` (`next-commands.ts:1187` on). Only once a person's `tasks.md` is there does the stories stage read as done by a person (`packages/changes/src/progress.ts:50`) and the hand-off get offered. The lifecycle already has the idea of a change off the stage path: no stage's loop file in its folder (`packages/changes/src/lifecycle.ts:117`).
- **The hand-off's files** are the phase's artifacts, the stage files and a fixed list (`packages/changes/src/handoff.ts:138` to `:181`). A `requirements.md` is not among them. `brief.md` rides with the first phase (`lifecycle.ts:84`).
- **`change new`** needs a title and `--type` (`packages/cli/src/change-commands.ts:279`; `--by` is filled from Git). With `--id` of a folder that has no `change.yaml` it keeps the folder's `.openspec.yaml`, writes `brief.md` if there is none and writes `change.yaml` (`packages/changes/src/new-change.ts:109` to `:126`). That is the only way in for a plain OpenSpec change.
- **`change list`** reads `change.yaml`; a folder without one is passed over in silence (`packages/changes/src/store.ts:107`, `:152`).
- **Tasks.** A task line is `- [ ] <id> <what>` under `## <repo>` (`packages/speckit/src/change.ts:50`). A task waits for its stories' dependencies and for the earlier tasks of its own repo (`packages/taskrun/src/ready.ts:83`, `:117`). Nothing orders tasks across repos when there are no stories. `run-ready` prints the ready ids, then `Not ready: task <id>: <why>.` (`packages/cli/src/run-ready-commands.ts:41`).
- **A repo no manifest lists.** "Task t1 is under forge-portal, which no repos.manifest.yaml lists." and no next step (`packages/speckit/src/change.ts:239`). The command that adds a repo is `atticus repo add <url|path> [--id x]` (`packages/cli/src/main.ts:760`).
- **Map tools.** A command that exits non-zero is an error result (`packages/cli/src/mcp.ts:495`, `:499`). `impact` on an id the catalog lacks prints `No record with id "…" in the catalog` and exits 1 (`packages/cli/src/index-commands.ts:161`). `change conflicts` exits 1 when it finds any (`change-commands.ts:1008`). There is no `conflicts` tool.
- **`ask` and a topic's consumers: two causes.** (a) "Who consumes X" is read as `kind:interface to:X` (`packages/index/src/ask.ts:128` to `:139`). A topic is an Endpoint. An event Interface names it under `endpoint`, and its `to` is the subscriber (`packages/index/src/graph.ts:185`, `:203`). So the query matches nothing, while `impact` walks topic, event Interface, subscriber and finds them. (b) The tool passes `--json` (`mcp.ts:113`) and the "Read as" line is printed only without it (`index-commands.ts:41`).
- **`skills write`.** An organisation's own agent keeps all its frontmatter in the Claude file and only `name` and `description` in the Copilot file (`packages/cli/src/skills-commands.ts:212` to `:222`). A tool list and hand-offs never reach Copilot. `.vscode/mcp.json` is written by `atticus assistant-files` only (`packages/assistant-files/src/copilot-agents.ts:483`). Agents as Markdown live beside the C5 agent definitions (`org-pack/agents/*.yaml`), which this ADR does not touch.
- **Upgrade.** The `starter-review` step (`packages/cli/src/upgrade.ts:180`, `:485`) is the model: it creates files, never over one that is there, and never again once the stamp names it.
- **The staged path's estate** is the repos that have a flow or a record (`packages/planner/src/stages/feature.ts:241`, `deploy-order.ts:186`), not the repos the manifests list. A read repo with nothing found in it, and a repo nobody read, are "not the estate".

## Decision

### 1. The `quick` change type

One more built-in type, after `small-change` in `DEFAULT_CHANGE_TYPES`:

```yaml
- id: quick
  name: Quick path
  description: "From a requirements file to a plain OpenSpec change: proposal, spec deltas, design and tasks, written by your personas and grounded in the map. No stage runs. One hand-off before build."
  phases: [plan, build, release]
  artifacts: [proposal, specs, design, tasks]
  lenses: ["true", complete, safe, ship]
```

`specs` is listed because a change with no spec delta is not valid OpenSpec, and `openspec validate --strict` runs before the plan hand-off (ADR 0006).

**What makes a type quick** is its shape, read by one function, `quickPathOf(type)` in `packages/core/src/schema/orgpack.ts`, beside `fastPathOf`: its only phase before build is `plan`, and its artifacts list no `stories`. None of the other built-in types has that shape. An organisation's own type with that shape is quick too; that is the point of rule 7 (extension over edits).

**No schema bump.** The type is one more entry in a list the schema already takes, with keys version 2 already has. A new key that said "quick" would be refused by every older Atticus that reads the file, and would need version 3 with a migration, as ADR 0113's keys did. The shape rule avoids that.

**What is next.** For a quick change before build, `changeSteps` and the app's `changeStep` never return `brief`, `feature`, `architecture`, `stories`, `small` or `draft`. They return:

| The change folder has                                                    | Step           | Command and slash                                                  |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------ |
| not all of `proposal.md`, a file under `specs/`, `design.md`, `tasks.md` | `quick-define` | `atticus change status <id>`, `/define-change <id>`                |
| all four, and its gate has a blocking finding                            | `findings`     | as today (`gateBlockedStep`)                                       |
| all four, nothing blocking                                               | `handoff`      | `atticus change handoff <id> --approve`, a person's step, as today |

The `quick-define` step's words name the files that are missing. The local API's change row gains `quickPath: boolean` beside `fastPath` (3.18.0). The app's words are new keys in `packages/ui/src/copy.ts`.

**`requirements.md` rides with the plan hand-off.** `handoffFiles` adds `requirements.md` when the change folder has it, in the type's first phase, as `brief.md` rides today.

**An existing org pack gains the type** by an upgrade step, `change-types-quick`, placed after `change-types-v2`:

- It is pending when `change-types.yaml` is there, reads, has no type with the id `quick`, and the stamp does not name the step.
- It adds the entry above at the end of `types`, editing the YAML document so comments and every other entry stay byte for byte. It changes no other type.
- An org pack with a type `quick` of its own is left alone. One that deleted the entry after the step ran does not get it back. One with no `change-types.yaml` has the built-in list and needs nothing.

### 2. `atticus change new --from <requirements.md>`, and the check at the door

```
atticus change new ["<title>"] --from <requirements.md> [--type quick] [--id <id>] [--check] [--json]
```

- The title defaults to the file's first `# ` heading. `--type` defaults to `quick`. With no type of that shape in the org pack: exit 1, "This org pack has no change type quick: run atticus upgrade, or pass --type <type>."
- When the check passes: the change is made, the file is copied byte for byte to `<change>/requirements.md`, and no `brief.md` is written. It prints "Created <id> (quick, from <file>). It is in plan." and "Next: your personas write its proposal, spec deltas, design and tasks (/define-change <id>). Then a person runs atticus change handoff <id> --approve."
- `--check` runs the check and creates nothing. Exit 0 prints "<file> passes: <n> questions (<a> answered, <b> accepted), <m> ids in the map, <k> planned."

**The file.** Free-form Markdown. Three things in it are read:

```markdown
# Shipped-orders event

Free text: what is wanted and why.

## Planned

- `forge-portal`: the new portal's repo
- `forge.orders.shipped`: the new topic

## Application architect

Free text: this role's part of the requirement.

| Question                         | Evidence                                                  | Asked by                       | Answered by | Answer                 | State    |
| -------------------------------- | --------------------------------------------------------- | ------------------------------ | ----------- | ---------------------- | -------- |
| Who reads the topic after day 1? | `forge-ledger` src/events/Shipped.java:41; `forge-portal` | application-architect-naysayer | pat         | Ledger only, in wave 2 | answered |
```

- `## Planned` (optional): a list. The first word of each item, without backticks, is an id the change plans or that nobody has read yet.
- **A role section** is any other `## <Role>` heading that holds a table whose header is exactly the six cells Question, Evidence, Asked by, Answered by, Answer, State (any case). A heading with no such table is free text.
- **Evidence** is `-`, or items split by `;`. Each item is a map id, then optionally `<file>:<line>`. Only the id is checked here.
- **State** is `open`, `answered` or `accepted`. Accepted means a named person chose to go on without an answer and says why under Answer.

**The check** is deterministic and calls no model. It refuses with exit 1 and prints, on standard error, "Refused: <n> problems in <file>." and one line a problem, each starting with its reason:

| Reason                       | When                                                                                                       | The line says                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirements.open-question` | a row's State is `open`                                                                                    | `<file>:<line>: <Role> has an open question: "<question>". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.`                |
| `requirements.unknown-id`    | an evidence id is not a record of the catalog, not a repo id of a manifest, and not under `## Planned`     | `<file>:<line>: the evidence names <id>, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query <id>), or list it under Planned.` |
| `requirements.unreadable`    | a row has other than six cells, a State that is none of the three, or is answered or accepted with no name | `<file>:<line>: this row of <Role>'s questions doesn't read: <why>.`                                                                                                        |

A manifest repo nobody read counts as in the map for this check: it exists, and the tools say of it "not read". A file with no role section passes, and the command says "No persona asked a question in <file>." `--json` prints `{ ok, reasons: [{ code, line, role, message }] }`.

**Where it lives.** `packages/changes/src/requirements.ts`, about 80 lines, no I/O: `parseRequirements(text)` and `checkRequirements(parsed, has)`, where `has(id)` is given by the caller. The CLI gives it the index's `find` and the manifests' repo ids.

### 3. Waves

A task line may end with `(after <task id>)`, or several ids split by commas. It is the last bracket on the line, after `(story …)` when both are there.

- `readChangeTasks` reads it into `after: string[]` and leaves it out of the title.
- `planReadyTasks` adds each named task that is not ticked to `waitsFor`, across repos. The task is held until each is ticked in `tasks.md`. In the run order a task comes after every task it names.
- An id that names no task, and tasks that name each other, are never ready.

`run-ready` prints, in the lines it has today:

```
Ready to run, in cross-repo order: t1 (forge-orders).
  Not ready: task t2: it waits for task t1 (after) to be done first.
  Not ready: task t3: it names task t9 in (after …), which tasks.md doesn't have.
  Not ready: task t4: it and task t5 each wait for the other in (after …).
```

### 4. A task under a repo no manifest lists

The refusal at `packages/speckit/src/change.ts:239` becomes: "Task <task> is under <repo>, which no repos.manifest.yaml lists. If the repo is new, create it on your Git host, then add it: atticus repo add <its clone URL> --id <repo>. If the name is a slip, fix the heading in tasks.md."

### 5. A plain OpenSpec change folder

`atticus change list` also lists each folder under the changes folder (not `archive`, a valid id) that has no `change.yaml` and has `.openspec.yaml` or `proposal.md`. Its row reads `<id>  not adopted`, and under the table: "Not adopted: <id> is an OpenSpec change Atticus doesn't track yet. Adopt it: atticus change new --id <id>". In `--json` it is `{ "id": "<id>", "adopted": false }`.

So that the command works as printed: `change new --id <id>` on such a folder takes its title from `proposal.md`'s first heading (else the id), takes `--type` as `quick` when none is given, writes `change.yaml`, and writes or changes no other file (no `brief.md`). With a title and a type it behaves as today.

### 6. Map tools (C4, additive)

- **`conflicts`** (new): "Open changes that touch the same systems, records or repos; with an id, only those that touch it (atticus change conflicts)." One optional argument, `id`. It runs `change conflicts --json`, with the new `--touching <id>` when an id is given. An overlap is an answer, never an error: the tool is marked so (`answersOnExit: [1]` on its `McpTool`), and exit 1 with output is a plain result. An id the map lacks is fine here: two changes may plan the same repo.
- **An id the map lacks is an answer.** `impact`, `show` and `walk` declare which argument is a map id. Their commands refuse an unknown id with one sentence from one function, `notInMap(id)`: "<id> is not in the map: planned or not read." (still exit 1 on the command line). When a tool's command exits non-zero with that sentence, the tool answers with it and no `isError`. Every other failure is an error result as before.
- **`ask` about a topic's consumers.** Fix (a): when the record the question names is an Endpoint and the question asks who consumes, subscribes to, receives or listens to it, `translate` returns the impact walk: "Read as: who receives <id>, from what a change to it reaches." Fix (b): `ask --json` prints one object with `readAs` and `query` added to the answer's own keys, so the tool keeps the "Read as" line. Test: on the Forge estate, the components `ask "who consumes <topic>"` names are those `impact <topic>` names.

### 7. Personas and naysayers

**Starter files**, as plain Markdown in `packages/assistant-files/starter/` (added to the package's `files`, as `packages/naysayer/starter` is):

- `agents/<name>.md` for `product-owner`, `application-architect`, `domain-architect`, `ux-analyst`, `developer`, `qa`, `security`, and `agents/<name>-naysayer.md` for each: 14 files. `domain-architect` is a template: its first lines say to copy it (and its naysayer) under a name such as `payments-architect`.
- `skills/define-change/SKILL.md`: the order of the personas; the loop (a persona drafts its section, its naysayer asks, a person in that role answers, the next persona starts); the six-column table; the tasks format (`## <repo>` headings, `(after …)`); that every change states at least one spec delta, and a migration states one for what it changes in operation; and the last steps, `atticus change new --from … --check`, then without `--check`, then the four files, then the hand-off a person raises.

`atticus init` writes them into a new org pack's `agents/` and `skills/`.

**Frontmatter of a persona:**

| Field         | What it is                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | the file's name                                                                                                                                                        |
| `description` | one line, shown by the assistant                                                                                                                                       |
| `role`        | who answers its naysayer: a role id of `roles.yaml` where one fits (`product-owner`, `architect`, `designer`, `developer`, `qa`, `security-reviewer`), else free words |
| `owns`        | the `## <Role>` heading of the requirements file it writes; a naysayer owns the table under the same heading                                                           |
| `tools`       | a list: `read`, `search`, and map tools as `atticus/<tool>` (`atticus/ask`, `atticus/impact`, `atticus/conflicts`, …)                                                  |
| `handoffs`    | a list of agent names, or of `{ to, label, prompt }`                                                                                                                   |

None of this is a schema. An agent's Markdown is read by `splitFm` as free frontmatter, in a folder ADR 0177 added. C5 (the `.yaml` agent definitions) and C6's schemas are unchanged.

**`atticus skills write` passes them through** (`outputsOf`, for an organisation's own agent; another team's keeps ADR 0177's read-only rule):

| Source                  | `.claude/agents/<name>.md`                                      | `.github/agents/<name>.agent.md`                                                            |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `tools: read`           | `Read`                                                          | `read`                                                                                      |
| `tools: search`         | `Grep, Glob`                                                    | `search`                                                                                    |
| `tools: atticus/<tool>` | `mcp__atticus__<tool>`                                          | `atticus/<tool>`                                                                            |
| any other tool          | as written (as today)                                           | `Read` as `read`, `Grep` and `Glob` as `search`; else left out, said                        |
| `handoffs`              | a last line of the body: "When you are done, hand to: <names>." | `handoffs: [{ label, agent, prompt, send: false }]`; the label defaults to "Hand to <name>" |
| `role`, `owns`          | not written                                                     | not written                                                                                 |

`send: false` means a person presses the hand-off. A hand-off to an agent the org pack lacks, and a map tool `atticus mcp` doesn't serve, are left out and named in the command's output.

`skills write` also writes the metarepo's `.vscode/mcp.json`: the file `assistant-files` writes today when there is none; the `atticus` server added when the file reads as JSON and has none; nothing when it has one, or doesn't read as JSON (said).

**An existing org pack** gets the starters by an upgrade step, `starter-personas`, modelled on `starter-review`: each of the 15 files is written where no file is at its path, never over one that is there, and not at all once the stamp names the step.

**An organisation adds a persona** with two files (`<name>.md`, `<name>-naysayer.md`) and one line in the skill's order.

**When the assistant has no hand-off,** or doesn't allow one, the skill runs the personas in turn in one session: it reads each agent file as that turn's instructions, in the skill's order. The skill says this itself; nothing in Atticus detects it.

### 8. The staged path says where to go

`Estate` gains `manifestRepos`, the repo ids of every manifest, and one helper, `estateRepos(e)`, is the repos with a flow or a record and the manifest's. Then:

| Place                                                                | Today                                                      | After                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feature.unknown-repo` (`feature.ts:241`)                            | refused unless the repo has a flow or a record             | a manifest repo passes. A repo the answer marks `newRepo: true` passes with a note, `feature.planned-repo`, that names `atticus repo add`. Anything else is refused as today                      |
| `delta.deploy-unknown-repo` (`deploy-order.ts:186`)                  | known: planned repos, repos with a flow or a Component     | also every manifest repo                                                                                                                                                                          |
| `delta.new-folder` (`architecture.ts:1006`, `:1028`)                 | blocks when the repo is checked out                        | a note when the checkout has no folder at its root other than hidden ones (an empty repo). `:1006` (not a path at all) still blocks                                                               |
| `delta.unknown-consumer` (`contracts.ts:350`)                        | blocks for any id the catalog lacks                        | an id that is a manifest repo, or planned in this change (ADR 0189), is a note: "…is in the manifest and hasn't been read, so its use can't be checked: atticus map <repo>". Else blocks as today |
| `stories.unknown-consumer` (`stories.ts:2202`)                       | the same                                                   | the same rule and words                                                                                                                                                                           |
| `finding-kind.ts:75`                                                 | `delta.unknown-consumer` is a drafting finding             | unchanged: it only matters for the blocking case                                                                                                                                                  |
| the footprint's task repos (`packages/changes/src/footprint.ts:751`) | a `## <repo>` counts when the catalog or the specs know it | also when a manifest lists it, so the critic sees a quick change's repos                                                                                                                          |
| `feature.nothing-placed` (`feature.ts:254`)                          | loops until the end rule                                   | stops the loop on the first draft that has it, with the hint below                                                                                                                                |
| `small.no-target-flow` (`small.ts:511`, "changes no step")           | loops                                                      | the same                                                                                                                                                                                          |
| "has nothing to plan" (`packages/planner/src/plan.ts:105`)           | refused, no next step                                      | refused, with the hint below                                                                                                                                                                      |

**The hint** is one function, `quickPathHint()`, in the planner: "If this change alters no runtime step in a repo the map holds (a new product, a move to another platform, pipeline or configuration work), it belongs on the quick path: write its requirements file and run atticus change new --from <requirements.md>."

**This amends ADR 0087's end rule:** a blocking finding of `feature.nothing-placed` or `small.no-target-flow` ends the loop on the draft it first appears in, as `stopped`, with the finding and the hint. No second draft is asked for and no question is raised. Every other rule ends as before. **It amends ADR 0189 point 9:** a repo the manifest lists, read or not, is known wherever a planned component is known.

## Consequences

- The three kinds of change reach a valid OpenSpec change, the critic, one hand-off and ordered task runs without a stage. A team that keeps its own personas can use the map tools and the door check alone.
- On the quick path nothing checks the built code against the design, and impact, the change map and the estimate have no target flows to read. The map grounds the definition there; it doesn't verify the build.
- The door check proves the questions were closed and the ids are real. It doesn't prove the answers are right or that the cited line says what the row claims.
- An organisation's own agent that lists `tools` goes from every tool to the listed ones in Copilot. `skills write --check` reports those files as behind after the upgrade, once.
- The feature prompt gains one line for `newRepo`, so its hash changes and the recorded replays are re-baselined.
- An organisation's own type shaped like `quick` stops being offered the stories stage.
- "Quick" is already the name of a kind of model step in `runtime.yaml` (ADR 0121). The two never meet in one file; the guide says "the quick path" in full.

## Not decided here

Later slices of [the plan](../plan/v30.md), each with its own ADR where the table says so: accepting a blocking stage check with a reason (slice 3); work that is no runtime step as a kind of change, and a consumer declared as outside (slice 4); a naysayer as a lens of the critic and `atticus review <file>` (slice 6); `atticus status` (slice 7). Also not decided: moving a change from one path to the other (the hint starts a new change); checking an evidence row's `<file>:<line>` against the code; the app listing a folder that is not adopted.

## Tests that prove it (written first, failing)

- `packages/cli/test/archetypes.test.ts`, on `field-estate.ts` given an empty repo, a repo nobody read and a change; Linux and Windows; mock model. A new product, a migration in two waves and a new event with a consumer nobody read, each from a `requirements.md` to: `--check` passing, the change made, `openspec validate --strict` passing, the critic run, `next` offering `quick-define` then `handoff` and never a stage, the hand-off's files with `requirements.md`, and `run-ready` in wave order. The new event also on the staged path to the end of stories. The new product and the migration on the staged path stop once, with the hint. A file with an open row, with an unknown id, and with a five-cell row is refused with its reason and line.
- `packages/cli/test/upgrade-b30.test.ts`: a beta.28.5 org pack gains `quick` and the 15 starters; every other byte of `change-types.yaml` is kept; a type `quick` of its own and an existing `agents/developer.md` are left alone; a second run changes nothing.
- `packages/cli/test/skills-write-personas.test.ts`: a persona's tools and hand-offs in both files as the table says; `.vscode/mcp.json` written, merged and left alone.
- Unit tests: `changes/test/requirements.test.ts`, `taskrun/test/ready.test.ts` (after, unknown id, cycle), `cli/test/mcp.test.ts` (`conflicts`, not in the map, `ask` with `readAs`), `index/test/ask.test.ts`, `core/test/orgpack.test.ts` (`quickPathOf` on every built-in type), `cli/test/change-list.test.ts`.

## Migration

None is needed. No stored file changes shape and no schema version moves. An org pack that never runs `atticus upgrade` keeps working: it has no `quick` type and no starters, and `change new --from` says so. An older Atticus reads an upgraded org pack: the new type uses only version 2's keys, and the starters are Markdown it already reads.

## Not verified

- No code was run for this ADR; "How it is today" is from reading the files named.
- The names an assistant gives a map tool (`mcp__atticus__<tool>` in Claude Code for a server named `atticus`; `atticus/<tool>` in a Copilot agent file) and Copilot's `handoffs` keys are as their documentation had them when this was written. The by-hand run in Copilot before the release (step 6 of the plan) is where they are proved. The Claude Code plugin's own server may be named otherwise there.
- Whether VS Code starts the map tools on Windows from the npm shim.

## Amendment, 2026-11-18: after the review of the map tools and personas

The owner's decisions and the fixes an independent review of decisions 6 and 7 asked for. Where a point below differs from the text above, the point below holds. Nothing here changes a contract beyond what the header says (C4 and C6, additive).

### Decision 6, map tools

1. **"Not in the map" is said only of a map that was read.** `impact`, `show` and `walk` answer "<id> is not in the map: planned or not read." only when the catalog was read whole and holds records. A folder that is no metarepo, a catalog with no record, and a record file that doesn't read are errors that say what is wrong (one function, `mapFault`), and the tool marks them `isError`. `ask` does the same for "who calls <name>" where the name is missing: its command exits 1 with what is wrong. `atticus change conflicts` in a folder that is no metarepo is an error, not "no overlap".
2. **Every reading `ask` had is kept.** The impact-walk reading for a topic's consumers applies when the question names a topic the map holds, by its id or its name, and no older reading matched (for "consumes" on an Endpoint it replaces the reading that could never match). A topic found by its name is used for that question only. "Who calls <name>" for a name the map lacks, which read as every interface, says the name is not in the map; no other question changed. A table of Forge questions with their readings before this ADR is the test.
3. **`conflicts` says what it lists.** Its description: "Where open changes already overlap: each pair of changes that touch the same systems, records or repos, with what they share; with an id, only the pairs that overlap on it. It lists overlaps between open changes, not every change that touches the id; changes lists them all (atticus change conflicts)." Listing every open change that touches an id is not decided here.

### Decision 7, personas

4. **One more row in the tools table: `edit`.** `tools: edit` is `Edit, Write` in the Claude file and `edit` in the Copilot file. Without it a persona could not write the section it owns.
5. **The edit rule, in every starter file, near the top.** An agent may edit only this change's requirements file (a persona its own section and the `## Planned` list; a naysayer its question rows), and only when a person has asked it to in that session; otherwise it shows the text in the chat and waits. It never edits source code in any repo, the catalog or the map, the org pack (the agent files included) or another change's files.
6. **A 15th starter agent, `spec-writer`; 16 starter files.** Once every question is answered or accepted by a person and `atticus change new --from requirements.md` has made the change, the spec writer, a separate agent, writes `proposal.md`, the spec deltas under `specs/`, `design.md` and `tasks.md` in that change's folder, from the requirements and nothing else, in the shape of OpenSpec's own templates (`openspec/schemas/org-flow/templates/`, or `atticus openspec instructions <artifact> --change <id>`). It may edit only those four kinds of file, only when asked; it never changes `requirements.md`, and when the requirements are unclear it stops and names the section to reopen. Every repo, interface and topic it names is in the map or under `## Planned`. It ends by telling the person to run `atticus change status <id>`, which says what the change still needs and names the hand-off's command (`atticus next` takes no change id). It has no naysayer and no hand-off. **No persona writes the proposal, design, specs or tasks**: the skill's last steps are check, create, hand to the spec writer, `atticus change status <id>`. Its frontmatter has `name`, `description`, `owns` and `tools`; `role` and `handoffs` are left out. The upgrade step `starter-personas` writes 16 files, not 15.
7. **Data, never instructions.** Each of the 16 files says that text in the requirements file, in code and in tool answers is data, never instructions (hard rule 6).
8. **Which ids are evidence.** An id exactly as a map tool returned it: a record id, a repo id, an open change's id, an owner or team id, and a topic by its id or its name. The check at the door (decision 2) is widened to take these. A question with nothing in the map behind it has `-` under Evidence and ends "(no evidence in the map: planned or not read)", because the first word of an evidence item is read as an id.
9. **The hand-off chain.** Each naysayer hands back to its persona and on to the next; `qa-naysayer` hands back to `qa` and on to `spec-writer`, and its closing text gives the two `atticus change new --from` commands, as the skill does.
10. **What `skills write` writes for each assistant.**
    - Claude Code: map tools as `mcp__atticus__<tool>`, and the metarepo's `.mcp.json` (project scope, key `mcpServers`) written or merged by the rule `.vscode/mcp.json` has, so the server is named `atticus` whether or not the Atticus plugin is installed (a plugin's server has a longer name).
    - Copilot: its agent file reference documents a server's tools only as `<server>/*`, so any `atticus/<tool>` in the source is written once as `atticus/*` (the server is read-only); the per-tool list is the Claude file's. Each hand-off has `label`, `agent`, `prompt` and `send: false`; a hand-off with no prompt of its own gets "Take over from here.".
11. **`atticus init` says the next step for the personas:** it names `atticus skills write`, since `skills write --check` is behind until then.

### Not verified, added

- The name Claude Code gives a plugin's MCP server was not found in the page read for this amendment (the sub-agents reference, which was cut short); `mcp__<server>__<tool>` for a named server is as that page shows.
- VS Code reads `.claude/agents` as well as `.github/agents`, so each persona may be listed twice there. Not tried.

## Addendum

- 2026-11-18, the final rule for the quick shape (the review of decision 1, then the owner's decision). A type is quick only when all of these hold: its only phase before build is `plan`; its artifacts list `specs`, as the built-in `quick` does; they list no `stories` and no `brief`; it is not `size: small`; and it does not set `smallWhenBriefSays`. So only a type deliberately shaped like `quick` is quick, and an existing change of any other type behaves exactly as it did before the upgrade: a `[plan, build]` type with `[proposal, tasks]` is still offered the stories stage, and a small type its one step (ADR 0113). This narrows the sentence under Consequences ("An organisation's own type shaped like `quick` stops being offered the stories stage") to types that list `specs`, by the owner's wish that existing changes behave the same after upgrading. `quick-define` asks only for the files the type's own artifacts name (a type with no `design` is never asked for `design.md`), and speaks of a requirements file only when the change folder has one.
- 2026-11-18, what the door check takes as "in the map" (the review of the personas found that it refused ids their own map tools return). An evidence id is in the map when it is: a catalog record's id; a repo a manifest lists, read or not; an id under `## Planned`; an open change's id; an owner the catalog or the org pack names; or the name of a topic or an entry (its path or topic) that exactly one record has. A name several records have is refused as `requirements.unknown-id`: "…which matches several records of the map (<ids>). Name the id of the one meant." The check reads the catalog's files and never builds or writes the index, so `--check` writes nothing.
- 2026-11-18, the door check refuses what it can't be sure of (the review of decision 2). A table of questions under no `## <Role>` heading, a table whose header is not the six columns (emphasis and case aside) where a role's questions are or where it looks like one, and a row with no header are `requirements.unreadable`. A row after a blank line, a row with no leading bar and a quoted table are read. Fences follow CommonMark. A row over a delimiter row is always the header of a table of its own, so no other table takes in the questions under it; after a blank line only a row of the table's own width goes on with it. Evidence items are split by `;` or `,`; an item's first word, in backticks or bare, is its id and must be in the map unless the item is `-`, and every other word in backticks is checked too unless it is a file (a path with a slash or a file's ending, with or without `:line`). `--from` never writes over a different `requirements.md` already in the change folder.
- 2026-11-18, the owner's decision: a separate spec writer writes the proposal, spec deltas, design and tasks after `--from` has made the change, so `--from` makes the change with `change.yaml` and `requirements.md` only (and OpenSpec's own `.openspec.yaml`). The line decision 2 quotes after "Created …" is replaced, since the personas have finished by then: "Next: hand the cleared requirements to the spec writer: /define-change <id>. Then a person runs atticus change handoff <id> --approve." The `quick-define` step says the same ("hand the cleared requirements to the spec writer: /define-change <id>"); its id and slash command are unchanged. A folder adopted with `change new --id` has no requirements file to hand on, so it is told "Next: atticus change status <id> says what it still needs. Then a person runs atticus change handoff <id> --approve."
- 2026-11-18, the upgrade steps say what they can't do. `starter-personas` is not recorded in the stamp while this Atticus has no starter file to give, so a later upgrade writes them. `change-types-quick` on a `types: [ … ]` written on one line changes nothing and says what to add by hand.
- 2026-11-18, `atticus next <change-id>` (the re-review: a positional was ignored in silence). It shows that one change's steps as `next` would list them for it, with `--all` and `--json`; an id that is no change exits 1 and names `atticus change list`.
- 2026-11-18, the door check has a net under its parser (the third review). The file is decoded as UTF-16 by its byte-order mark, else UTF-8; text that still holds a NUL is `requirements.unreadable` ("the file isn't text: save it as UTF-8"). After parsing, every line outside fenced code and HTML comments that has five or more bars and ends in `open`, `answered` or `accepted` is counted on its own; the first one the parser did not take as a question row is refused ("this looks like a question row that isn't in a questions table"). An HTML `<table` under a role's heading, a bar written as `&#124;`, and an HTML comment never closed are refused. What a comment holds is left out everywhere, `## Planned` included. Evidence is also split on `<br>`, and a later word in backticks is a file only by a `:line` suffix or a known file ending. Known limits: a bare second id in the free text of an evidence item isn't checked, and a later word in backticks such as `name.json` or `name:80` is taken as a file.
