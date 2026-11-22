# A change in OpenSpec: its specs, its gates and its work items

OpenSpec is the foundation and Atticus is a layer on top of it ([ADR 0006](../adr/0006-openspec-stable-core.md)). A change is an OpenSpec change under `openspec/changes/<id>/`, with the `org-flow` schema (version 2). Its artifacts are the files Atticus's stages write:

| Artifact | File                               | Written by                                                   |
| -------- | ---------------------------------- | ------------------------------------------------------------ |
| proposal | `proposal.md`                      | `atticus change feature`, from `brief.md` and `feature.yaml` |
| design   | `design.md`                        | `atticus change architecture`, from `target-flows/`          |
| stories  | `stories.md`, `stories/<story>.md` | `atticus stories`                                            |
| specs    | `specs/<capability>/spec.md`       | `atticus stories`, from the stories' acceptance criteria     |
| tasks    | `tasks.md`                         | `atticus stories`, numbered per story (1.1, 1.2, 2.1 …)      |

The architecture stage also writes `data.md` when a target flow changes the schema (a new table, a migration, a column with a type). It isn't an org-flow artifact and there is no template for it: a change that only reads or writes columns the catalog already has gets no `data.md`, and nothing asks for one — its data changes are the design's own **Data changes** section.

OpenSpec ships inside the installed Atticus package rather than on your PATH, so run it as `atticus openspec <the same words>`: `atticus openspec status`, `atticus openspec instructions apply`, `atticus openspec list --specs`. `status`, `instructions` and `show` need a `--change`, and Atticus fills it in when exactly one change is open. It runs the commands that read the metarepo and write nothing (`validate`, `list`, `show`, `view`, `status`, `instructions`, `templates`, `schemas`, `version`, `doctor`, `help`) with their own options, and refuses the rest before OpenSpec runs, naming what Atticus runs instead: `init` is `atticus openspec setup`, `update` is `atticus upgrade`, `archive` is `atticus change archive <id>`, and `--store`, which points OpenSpec at another root, is never passed on.

`atticus openspec status` shows the same progress `atticus next` reads. Edit `feature.yaml`, the target flows or the stories' answer and run the stage again; never edit the generated files. An organisation changes what each stage is told through `openspec/config.yaml` (`context`, and `rules` per artifact), which every stage reads first through `openspec instructions`.

## The order of tasks in `tasks.md`

A task is a line `- [ ] <id> <what>` under a `## <repo>` heading, and may end with `(story <story id>)`. `atticus task run-ready <change>` (**Run all ready tasks** on the Task board) runs the tasks that are ready, in cross-repo order, and says why each other one waits:

- **Its stories.** A task waits for the tasks of the stories its story depends on (`stories.md`, "Depends on").
- **Its repo.** A task waits for the earlier tasks of its own repo, so each is drafted from a base with the code before it. Mark tasks `[P]` (`- [ ] 1.2 [P] Add the column`) to let the `[P]` tasks next to each other in a repo go together.
- **Waves across repos.** End a task's line with `(after <task id>)`, or several ids as `(after t1, t2)`, `(after t1; t2)` or `(after t1 and t2)`, to hold it until each task it names is ticked, in whichever repo that task is ([ADR 0201](../adr/0201-the-quick-path-and-personas-that-ask-the-map.md)). It sits among the brackets that end the line, before or after `(story …)`. It is read as a wave when at least one name is a task id of the file; any other name in it is then reported as an id `tasks.md` doesn't have. A bracket that names no task, such as "(after lunch)" or "(after v2)", stays part of the title, and `run-ready` prints a note saying so, in case it was a mistyped id.

```markdown
## forge-orders

- [ ] t1 Publish the shipped event

## forge-ledger

- [ ] t2 Read the shipped event (after t1)
```

`run-ready` then prints `Not ready: task t2: it waits for task t1 (after) to be done first.` A task that can never run as the file stands is named with its reason: it names a task `tasks.md` doesn't have, its id is used twice, or it and another task each wait for the other (by `(after …)` alone, or by `(after …)` against the order of a repo's tasks). Tasks that each wait for the other are looked for in `(after …)` and the order of a repo's tasks only; a ring that runs through the stories' "Depends on" isn't named, and its tasks just show what they wait for. `atticus task run <change> <task>` refuses only a task its `(after …)` holds, in the same words; nothing overrides it, so tick the tasks it names or fix `tasks.md`. The order within a repo and the stories' dependencies are what `run-ready` follows: a person may still run one such task by itself. A task under a heading no `repos.manifest.yaml` lists is refused with what to do: add the new repo (`atticus repo add <its clone URL> --id <repo>`) or fix the heading.

## Where the stages point elsewhere

Every repo a manifest lists is part of the estate for the stages, read or not; an archived one is not, and the finding says so. A manifest that doesn't read lists no repo, and the finding about a repo "the estate doesn't have" names the manifest and what is wrong with it. Three notes never block a stage (ADR 0201):

- A new flow in a repo the feature answer marks `newRepo: true` passes with a note that names `atticus repo add`.
- A consumer that is a manifest repo nobody read, or a component the change plans, is noted as one whose use can't be checked, with `atticus map <repo>`.
- A new file's folder in an empty repo (no folder at its root but hidden ones) is noted, since the change gives the repo its layout.

A feature draft that touches nothing (no flow and no operation), a fast-path draft that changes no step and has no operation, and `atticus plan stories` on a change with nothing to plan stop at once and name the quick path: write the change's requirements file and run `atticus change new --from <requirements.md>`.

## A change that moves or deploys things

Some work changes no runtime step: a service deployed on another platform, a pipeline for a new repo, a setting carried over, a secret's key, a route, a cut-over. The stages take it as **operations** (ADR 0203), so a platform migration and a product in new repos go through feature, architecture and stories like any other change.

- **Feature.** `feature.yaml` may list `operations`, each with its `kind` (`deployment`, `pipeline`, `config`, `secret`, `route` or `cut-over`), the `repos` it is done in, `what` and `why`. A repo that doesn't exist yet is marked `newRepo: true`, as a new flow's is. It may also list `outside`: a party the change names that no repo of the estate holds, such as a partner's system; an id the catalog has is refused there.
- **Architecture.** The operations are kept in one file, `target-flows/_operations.yaml`, beside the target flows. Each has an `id`, may cite under `today` the catalog's records of what is there now, may say under `sets` what a rescan will find afterwards (a deployment's `platform`, `env` or ingress `host`, a setting's `key`), and may come `after` other operations. Repos that go in groups are listed under `waves`. Every cut-over gives an `undo`: rollback is not a kind of its own. A secret names its key and where its value is kept, never the value.
- **What runs today.** The feature and architecture prompts carry, as data, where each repo's component runs, its Deployment records and its Setting keys and kinds (never a value), each with its id. `design.md` gains "Operations": a row for each operation and repo, with what is there today, cited where the record was read, and what it becomes. An operation with an `undo` is a row of "Rollout and rollback".
- **Stories and tasks.** One story for each operation and one task for each of its repos, numbered `o1.1`, `o1.2`, and so on. Your assistant words the story and writes each task's acceptance criteria; a task without one is refused. In `tasks.md` a task of the second wave ends with `(after …)` naming the last tasks of the first, so `atticus task run-ready` holds it until those are ticked. The spec deltas are one capability for each repo, `<repo>-operations`.
- **The fast path** (`atticus change small`) takes `operations` in its one answer too.

The architecture stage refuses, by rule: a repo the estate doesn't have and the change doesn't plan (`operation.unknown-repo`); an id under `today` that is no record of the operation's repos (`operation.unknown-today`); a cut-over without `undo` (`operation.no-undo`); an `after` that names no operation, or a circle (`operation.after`); a repo in no wave or in two (`operation.wave`); and an operation the feature lists that is missing (`operation.missing`). It notes, without blocking, a deployment or route operation that cites none of the Deployment records the catalog has (`operation.today-uncited`).

The plan's order is one: waves, then `after`, then each repo's own order. A plan whose tasks could never all run, such as a first-wave task that comes after an operation done only in the second wave, is refused with the ring named (`operation.order`). The stories stage checks the operations file again, so an `undo` taken out after the architecture stage is refused there too. An `undo` says how the cut-over is taken back: `n/a`, `none`, `-` or `tbd` is refused. A secret-looking value written in an operation is redacted by the facts' rules (a password in prose, a credential with no scheme), only the value: a key and a record id stay. An undo that only says no undo applies ("Not applicable here.", "There is nothing to roll back.") is refused, and a cut-over comes after its repo's migrations and code in the deploy order.

**Checked against the code after the build ([ADR 0206](../adr/0206-operations-and-quick-changes-checked-against-the-code.md)).** `atticus change conform <change>` looks for each operation, in each of its repos, in the verified facts of the branch's commit, and says one of five things, each with its file and line and what to do next:

| Result              | When                                                                                                                                                     | What you do                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Present             | a verified fact says what `sets` says                                                                                                                    | nothing: the line is cited for the reviewer                                                                      |
| Present differently | a fact says something else: another platform for that env, another host, a setting in another env or with another value, a secret's key set to a literal | change the branch, or the operation if the design was wrong, and check again; or waive the finding with a reason |
| Missing             | the facts cover the commit with nothing unread, and none has it                                                                                          | build it on the branch, in the repo the operation names                                                          |
| Not checkable       | a cut-over, an operation with no `sets`, a pipeline with no `file`                                                                                       | check it by hand, then waive its finding with a reason that says how                                             |
| Couldn't confirm    | a file changed on the branch and no fact covers it, or the repo was read by the built-in readers only                                                    | have your assistant read those files into the change's `conform/facts/<repo>.jsonl`, then check again            |

`sets` takes `platform` and `env` (a deployment), `host` and `basePath` (a route), `key`, `env` and `value` (a setting), `key` (a secret, never its value) and `file` (a pipeline). `atticus verify` checks a host, a base path and a setting's key on the line it cites; a platform or an env is the assistant's reading of the line unless it is written there, and the result says which. A secret's value is never read, compared or shown. Missing, present differently and not checkable are findings on the conform gate (`conform.missing`, `conform.differs`, `conform.not-checked`) and hold the Build, QA and Go/no-go hand-offs; "couldn't confirm" is listed in those hand-offs' pull requests for a reviewer.

The branch's own facts are kept in the change folder, not in the catalog: `atticus verify <repo> --write` reads the repo's base clone at its own branch, so it can't speak for a task branch. The check verifies `conform/facts/<repo>.jsonl` against the branch's checkout, each fact on its line, and uses it for the files it cites.

Atticus never connects to a live system, so a cut-over is never verified by it. `atticus change estimate` counts each operation task as a unit, class `operation/<kind>`; give the class a range in `estimates.yaml` to size it.

## What a quick change's code will have

A quick change has no target flows, so its `design.md` says what the code will have, one row each, under `## In the code` ([ADR 0206](../adr/0206-operations-and-quick-changes-checked-against-the-code.md)). The spec writer writes it:

```markdown
## In the code

| Repo         | Task | Has       | What                               | Spec                                             |
| ------------ | ---- | --------- | ---------------------------------- | ------------------------------------------------ |
| forge-orders | t1   | publishes | `forge.orders.shipped`             | orders-shipped: An order that ships is published |
| forge-ledger | t4   | listens   | `forge.orders.shipped`             | orders-shipped: An order that ships is published |
| forge-ledger | t4   | calls     | `forge-orders GET /v1/orders/{id}` | orders-shipped: An order that ships is published |
```

Repo is a `## <repo>` of `tasks.md`, Task a task under it or `-`, Spec a `### Requirement:` of the spec deltas or `-`. Has is one of `serves`, `listens`, `calls`, `publishes`, `table`, `column`, `migration`, `deployment`, `route`, `config`, `secret`, `pipeline`, `cut-over` (`undo:` and how) and `other` (a person checks it). Every repo of `tasks.md` has a row. The plan hand-off is refused without the table, or with a row it can't read, with the line and what to fix; `atticus change status` lists them. A name of the map in the spec deltas that no row states is a note there, never a refusal: what a sentence means isn't read from prose.

After the build, `atticus change conform` checks each row as it checks an operation (present, present differently, missing, not checkable, couldn't confirm), and lists what the branch adds that no row names as not in the design. `atticus change map` draws the rows, `atticus change impact` lists who receives what each row names (never counted as breaks: a quick change states no fields), and `atticus change estimate` counts a unit a row, class `quick/<has>`. Before the table is written, they read `tasks.md`'s repos and say what the table would add.

## Drawing a change on the canvas

A change's target flows can start as a drawing ([ADR 0179](../adr/0179-drawing-a-change-on-the-canvas.md)). Under the change's diagram (**Design › Change diagram**), **Draw the change** takes a stroke at a time: a call one component makes to another's API (ticking _the API doesn't exist yet_ when it is new), a topic it publishes and a component that listens, a table it reads or writes, a step of today's flow taken out or sent elsewhere, or a new flow of a component the catalog doesn't have yet, with what starts it. **Preview** shows the lines the stroke adds to `target-flows/<flow>.yaml`; **Draw it** writes exactly those lines, the picture redraws with the stroke marked, and **Undo** takes any stroke back. When a component has several flows, the panel asks which one the stroke is on.

Drew it elsewhere first? `atticus change sketch <change> --from <file.drawio|.mmd>` reads a draw.io export or a Mermaid flowchart as strokes: a line marked new (or not on today's map) is a call, or a topic when its label names one; a line marked retired takes today's step out; a box the catalog doesn't know can be a call's target, not its start (a new flow needs a name and a trigger the picture can't give, so draw that one in the app). It shows what it would draw and writes with `--save`. In VS Code (**Atticus: Open the Change diagram**) and IntelliJ (the Change diagram action) the same page opens, Draw the change under it.

Or say the strokes instead of drawing them: `atticus change sketch <change> --from strokes.yaml` reads a list of the canvas's strokes, applied in order, with the same preview and `--save` (ADR 0193). An `absorb` stroke folds a component into another: its flows move with the same entries, it is retired, and its callers now call the other at the same entry, so their contracts don't change.

```yaml
strokes:
  - kind: absorb
    component: forge-accounts-wrapper
    into: { component: forge-api, runsOn: { type: service } }
    why: One API service instead of a wrapper each
```

The drawn files are ordinary target flows, so review them in the pull request like any other; `atticus change architecture <change>` then drafts the steps around them and never removes or moves a drawn step. A stroke is a plan: the map changes only when the code lands and is read.

**A component retired** takes a component away: every flow of it today is removed, in one stroke that Undo takes back together. A component you draw as new (a new flow of a component the catalog doesn't have, or a call to one marked new) is _planned in this change_: the architecture and stories stages and the critic know it before any repo builds it, and the deploy order may name it, marked planned ([ADR 0189](../adr/0189-a-stage-is-one-conversation.md)). After each stroke is drawn the form starts clean: _the API doesn't exist yet_ isn't carried over to the next one.

## A stage is one conversation

Each stage of a change is one thread on its own tab ([ADR 0189](../adr/0189-a-stage-is-one-conversation.md)): the proposal and a small change's one step on **At a glance**, the feature stage on **Feature design**, the architecture stage on **Architecture**, the stories stage on **Stories**. The thread holds, in order, the prompt for your assistant, its answer and what the checks said, what the stage wrote, what the critic found, the questions it asks a person, and what you told the assistant.

One round, from the app only:

1. Press **Start the stage** (or **Start the next round**). Atticus writes the prompt; it appears in the thread with **Copy the prompt**.
2. Paste it into your assistant (Copilot or Claude Code, in VS Code or IntelliJ). The prompt asks it to write one file and stop; there is nothing to run.
3. Wait. The app notices the file once it is complete (it has sat unchanged for a few seconds and reads as an answer), checks it as Done would, and the thread shows the answer, what the stage wrote, and the critic's findings and questions as they come. **Done** on Set up › Model runs still checks an answer at once if you want it to.
4. Answer the questions in place; on a finding, **Reply** (your words go to the next round about it), **Make the fix** (to the assistant in the next round, or, for a file the stage's assistant doesn't write, the file opens at its line here), **Ask** its owner, or **Not relevant** with why. A question the assistant raised whose line didn't match is shown, never dropped: **Keep it anyway** keeps it, citing the nearest line.
5. Write in **Tell the assistant…** at the bottom and **Send and start the next round**: the next prompt carries your words as your answer.

A round is one paste: the context step that used to come first (the expander) is read without a model in a hand-off. Where the critic's AI lenses are on, they review the draft in a prompt of their own, a fresh session as before, shown in the thread as the critic's prompt. The prompt sizes, models and file paths are under **Details**; **Set up › Model runs** keeps every run for an administrator.

## Starting a change from your own analysis

If you start a change with notes of your own (acceptance criteria, edge cases, field rules, error messages, what it must do under load), attach them to the change before its first stage: `atticus change attach <change> notes/*.md`, or **Attach a file** on the change's page ([ADR 0113](../adr/0113-small-changes-fast-files-into-a-change-and-the-task-context.md)). Markdown and text are read line by line; a PDF or slides page by page.

What each stage reads of them:

| Stage                         | Reads the attached files | What it takes from them                                                               |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `atticus change feature`      | yes                      | the outcomes and scope, beside `brief.md`                                             |
| `atticus change architecture` | yes                      | what the target flows must do                                                         |
| `atticus stories`             | yes                      | acceptance criteria, edge cases, field rules, error messages and non-functional needs |
| `atticus change small` (fast) | yes                      | all of the above, in its one step                                                     |

Each criterion the stories take from a note cites it under the criterion, `From inputs/<file>:<line>, quoting: "<the note's words>"`, and Atticus checks the words are on that line; the critic checks it again (the starter review's `review.note-cites-on-line`). Long notes are trimmed to the parts most related to the stories, and the stage says which lines it left out. A file that hides instructions for an AI is kept out of every step until a person decides, and the stage says so.

**Code wins.** Where a note says something the code contradicts (an entry's path, a field, who calls what, the order of the steps), the stories follow the code, the story's Context lists the difference, and you are asked a question naming the note's line and the code's: is the note out of date, or should the change make the code do what it says? Answer it and run the stage again.

## How a change's specs accumulate

Each flow a change adds or changes is a capability in `openspec/specs/`, named after the flow (with its repo in front when the estate has several). Its spec has one requirement per flow, worded from the story ("The system SHALL give a shop owner …"), and one scenario per acceptance criterion (GIVEN, WHEN, THEN).

1. The stories stage writes the change's deltas: `## ADDED Requirements` for a flow `openspec/specs` doesn't have yet, `## MODIFIED Requirements` for one it has (every archived scenario is carried; a scenario whose outcome reads the same is replaced), `## REMOVED Requirements` for a removed flow.
2. `openspec validate <change> --strict` checks every draft before it is written. A failure is a blocking finding of the stage. It runs again before the stories' hand-off and before archive.
3. `atticus change archive <id>` runs `openspec archive`, which merges the deltas into `openspec/specs/`. The next change on the same flow starts from that spec.

A criterion whose outcome changed becomes a new scenario beside the old one, since OpenSpec never drops a scenario silently. Retire the old one in `openspec/specs/` in the change's pull request.

## A repo's starting spec, from its verified flows

A repo that has never had a change has nothing in `openspec/specs/`, so its first change would write every flow it touches as ADDED. Seed it first, once its flows are verified (`atticus verify <repo> --write`) ([ADR 0146](../adr/0146-a-repos-starting-spec-seeded-from-its-flows.md)):

```text
atticus spec seed forge-orders
atticus spec accept forge-orders
```

1. `atticus spec seed <repo>` writes the change `openspec/changes/seed-<repo>/`: a capability per flow, named as the stories stage names it, with one requirement for the flow and a scenario for its main path, each branch and each error case. Every WHEN, THEN and AND is the flow's own words with the lines they cite; where the flow says nothing, the scenario says nothing. Retired and planned flows, and flows `openspec/specs/` already has, are left out and listed in its `proposal.md`. Nothing is written into a code repo or into `openspec/specs/`.
2. Read each spec against the code it cites and edit what reads wrong. Delete a file's first line (the mark) and a second `spec seed` keeps it as you left it.
3. `atticus spec accept <repo>` runs `openspec validate --strict` and `openspec archive`, which writes the capabilities into `openspec/specs/`, and records in the proposal who accepted it. Commit the metarepo and open its pull request.

From then on the stories stage writes `## MODIFIED Requirements` for each seeded flow a change touches, keeping the seeded scenarios, and each change's archive keeps the specs current. Accept a repo's seed before a change on its flows reaches the stories stage; if one got there first, run its stories stage again after accepting. Atticus warns when this happens ([ADR 0156](../adr/0156-a-changes-impact-up-the-chain-seeds-and-vendor-headers-and-errors.md)): the stories stage, when it writes ADDED for a flow an open seed adds too; `atticus spec seed`, naming each change that already adds one of the seed's flows; and `atticus next`, whose first step for that change is for a person to accept the seed (`atticus spec accept <repo>`), then run the change's stories stage again.

## The business analyst shapes the stories (ADR 0191)

The stories are worked out from the target flows, one per repo and flow. On the change's **Stories** tab the business analyst can rename a story, split one into two, merge stories of one repo, or add one, in plain words (`POST /api/changes/<id>/stories/shape`). Atticus keeps it in `stage/stories-shape.yaml`: a rename and a merge keep the story's number, a split's new part and an added story take the next free number at once (reserved in `stage/stories-numbers.yaml`, so they never move). The next draft of the stories (`atticus plan stories <change>`, or Draft the stories again on the tab) gets the shaping and puts each task under the story it belongs to; that mapping is kept, so the task's context and every later read agree. A task that moves takes the next free task number in its new story. The stage refuses a story the analyst named that ends up with no task, and the critic's `tasks-cover-stories` check at the plan gate says what no task serves. A shaping no draft has read yet can be taken back.

## Putting the stories in the work tracker

The Stories tab lists the change's feature, each story and its tasks as work items, with what `sync.yaml` remembers of each (`GET /api/changes/<id>/work-items`). **Put them in the work tracker** writes them (`POST`), the same as `atticus ado sync <change> --approve <you>`: with `adapters.workTracker: { type: manual }` each is a step on Home › Manual steps with the fields to copy (title, description, acceptance criteria, parent) and where to record the id the tracker gave it; with a live tracker it asks you to confirm first (ADR 0186). The ids are kept under each story's and task's stable key, so a later sync updates those items and never makes second ones.

## Exporting the stories to Azure DevOps or Jira

With no API to your tracker, import a file:

```text
atticus change export add-fraud-check ado --out add-fraud-check.csv
atticus change export add-fraud-check jira --out add-fraud-check.csv
```

- **Azure DevOps** (Boards, then Import Work Items, then the file): one User Story per story (Title 1) with its Tasks under it (Title 2), the criteria as a list in Acceptance Criteria, the change and the repo as Tags. Description and Acceptance Criteria are HTML, escaped as ADO expects. `--area` and `--iteration` fill Area Path and Iteration Path; otherwise they are blank and ADO uses the project's defaults.
- **Jira** (the CSV import): a Story per story and a Sub-task per task, linked by Parent; map the columns in Jira's import wizard.

Nothing is sent anywhere: a person imports the file and keeps the numbers (1.1, 1.2 …) the change's files use. Each task names its prompt file (`tasks/<n>.prompt.md`) for Copilot or Claude Code.

## Compatibility with newer OpenSpec

Atticus pins OpenSpec 1.14.0 and accepts any release from 1.13 below 2. `atticus doctor` shows the OpenSpec version, which beta features it has (stores, worksets, context, doctor, schema) and which path Atticus takes for each. Stores are read with `openspec list` run in each store, and from their files only when that can't run.
