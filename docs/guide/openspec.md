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

## How a change's specs accumulate

Each flow a change adds or changes is a capability in `openspec/specs/`, named after the flow (with its repo in front when the estate has several). Its spec has one requirement per flow, worded from the story ("The system SHALL give a shop owner …"), and one scenario per acceptance criterion (GIVEN, WHEN, THEN).

1. The stories stage writes the change's deltas: `## ADDED Requirements` for a flow `openspec/specs` doesn't have yet, `## MODIFIED Requirements` for one it has (every archived scenario is carried; a scenario whose outcome reads the same is replaced), `## REMOVED Requirements` for a removed flow.
2. `openspec validate <change> --strict` checks every draft before it is written. A failure is a blocking finding of the stage. It runs again before the stories' hand-off and before archive.
3. `atticus change archive <id>` runs `openspec archive`, which merges the deltas into `openspec/specs/`. The next change on the same flow starts from that spec.

A criterion whose outcome changed becomes a new scenario beside the old one, since OpenSpec never drops a scenario silently. Retire the old one in `openspec/specs/` in the change's pull request.

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
