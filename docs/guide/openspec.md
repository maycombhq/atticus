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

OpenSpec ships inside the installed Atticus package rather than on your PATH, so run it as `atticus openspec <the same words>`: `atticus openspec status`, `atticus openspec instructions apply`, `atticus openspec list --specs`. `status`, `instructions` and `show` need a `--change`, and Atticus fills it in when exactly one change is open.

`atticus openspec status` shows the same progress `atticus next` reads. Edit `feature.yaml`, the target flows or the stories' answer and run the stage again; never edit the generated files. An organisation changes what each stage is told through `openspec/config.yaml` (`context`, and `rules` per artifact), which every stage reads first through `openspec instructions`.

## Drawing a change on the canvas

A change's target flows can start as a drawing ([ADR 0179](../adr/0179-drawing-a-change-on-the-canvas.md)). Under the change's diagram (**Design › Change diagram**), **Draw the change** takes a stroke at a time: a call one component makes to another's API (ticking _the API doesn't exist yet_ when it is new), a topic it publishes and a component that listens, a table it reads or writes, a step of today's flow taken out or sent elsewhere, or a new flow of a component the catalog doesn't have yet, with what starts it. **Preview** shows the lines the stroke adds to `target-flows/<flow>.yaml`; **Draw it** writes exactly those lines, the picture redraws with the stroke marked, and **Undo** takes any stroke back. When a component has several flows, the panel asks which one the stroke is on.

Drew it elsewhere first? `atticus change sketch <change> --from <file.drawio|.mmd>` reads a draw.io export or a Mermaid flowchart as strokes: a line marked new (or not on today's map) is a call, or a topic when its label names one; a line marked retired takes today's step out; a box the catalog doesn't know can be a call's target, not its start (a new flow needs a name and a trigger the picture can't give, so draw that one in the app). It shows what it would draw and writes with `--save`. In VS Code (**Atticus: Open the Change diagram**) and IntelliJ (the Change diagram action) the same page opens, Draw the change under it.

The drawn files are ordinary target flows, so review them in the pull request like any other; `atticus change architecture <change>` then drafts the steps around them and never removes or moves a drawn step. A stroke is a plan: the map changes only when the code lands and is read.

**A component retired** takes a component away: every flow of it today is removed, in one stroke that Undo takes back together. A component you draw as new (a new flow of a component the catalog doesn't have, or a call to one marked new) is _planned in this change_: the architecture and stories stages and the critic know it before any repo builds it, and the deploy order may name it, marked planned ([ADR 0188](../adr/0188-a-stage-is-one-conversation.md)). After each stroke is drawn the form starts clean: _the API doesn't exist yet_ isn't carried over to the next one.

## A stage is one conversation

Each stage of a change is one thread on its own tab ([ADR 0188](../adr/0188-a-stage-is-one-conversation.md)): the proposal and a small change's one step on **At a glance**, the feature stage on **Feature design**, the architecture stage on **Architecture**, the stories stage on **Stories**. The thread holds, in order, the prompt for your assistant, its answer and what the checks said, what the stage wrote, what the critic found, the questions it asks a person, and what you told the assistant.

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
