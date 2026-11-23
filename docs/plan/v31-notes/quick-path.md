# v31 notes: the quick path's tasks and knowledge, and a planned topic's schema

What the shared files should say for branch `b31/quick-path` (WP-05 and ADR 0207 part 4). The
integrator copies these in; this branch doesn't edit CHANGELOG.md, docs/build-status.md or
docs/codebase-map.md.

## Changelog lines (2.0.0-beta.31, Added / Changed)

- The quick path's plan hand-off checks each task of `tasks.md` as the stories stage checks a
  story's tasks: `stories.no-criteria` refuses the hand-off for a task with no acceptance
  criteria at all, with its line and what to add; `stories.no-error-case` (a task that takes
  requests, calls another system, publishes or writes data with no criterion for a failure) and
  `stories.unknown-entry` (a criterion naming an entry nothing has) are notes in
  `atticus change status` and the hand-off PR.
- A quick task's acceptance criteria are its own indented `- Given …, when …, then …` lines under
  its checkbox line, or the scenarios of the spec requirement its row of design.md's
  `## In the code` names in its Spec cell.
- `atticus change handoff <id> --approve` on a quick change in plan writes `knowledge.yaml`, the
  org's knowledge its cited ids and words lead to (no model), and says how many items apply, or
  that nothing was found. `knowledge.yaml` rides with every hand-off that has it.
- ADR 0207 part 4: a publish step to a new topic may carry `topic` (format, schemaFile, key,
  fields with types, classification, settings). Six rules: `delta.topic-fields`,
  `delta.topic-exists`, `delta.topic-twice`, `delta.topic-classification`, `delta.topic-secret`
  (blocking) and `delta.topic-no-schema` (a note). design.md gains "Topics this change adds".
  The flow delta stays version 2.

## build-status.md entry

- v31 WP-05, the quick path's quality: done in `b31/quick-path`. Task checks at the plan
  hand-off (only no criteria blocks), knowledge.yaml for a quick change. Not done: marking a
  statement about a planned component "planned, unverified" in task text (WP-05's third
  acceptance line); a knowledge item's quote in knowledge.yaml (the list has its title and file).
- v31 ADR 0207 part 4, a planned topic's schema: done in `b31/quick-path`: the `topic` key, the
  six rules (run wherever the target flows are checked: the architecture stage, the fast path,
  and again on file), the design table, the architecture prompt's lines. Not done: the
  publisher's and listeners' task criteria in the stories stage, the post-build look for
  `schemaFile` in the commit's tree, the field estate's staged change with a new topic and the
  upgrade test's line.

## codebase-map.md lines

- `packages/changes/src/quick-tasks.ts`: a quick change's tasks and their criteria
  (`quickTaskCriteria`), checked with the stories stage's rules (`checkQuickTasks`); called by
  `codeTableState` (`code-table-check.ts`) for the plan hand-off.
- `packages/planner/src/stages/topic.ts`: ADR 0207 part 4, a planned topic's checks
  (`topicIssues`, called by `checkDeltas`) and design.md's "Topics this change adds"
  (`renderTopics`, called by `renderArchitecture`).
- `packages/planner/src/stages/knowledge-applies.ts`: `recordQuickKnowledge`, a quick change's
  knowledge list from the index, with no model.
- `packages/cli/src/quick-knowledge.ts`: the hand-off's knowledge line for a quick change.

## Help and guide text

No new command or flag. For the define-change skill (`packages/assistant-files/starter/skills/
define-change/SKILL.md`, owned by the persona-files builder), under `tasks.md`:

> Each task has its acceptance criteria: indented under its line, one per line, as
> `- Given …, when …, then …` (one says what happens when it fails, if the task takes requests,
> calls another system, publishes or writes data), or its row of `## In the code` names, in
> Spec, a requirement whose scenarios are its criteria. The plan hand-off refuses a task with
> neither.
