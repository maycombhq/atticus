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
  its checkbox line, or one scenario of a spec requirement its row of design.md's
  `## In the code` names in its Spec cell. A scenario vouches for one task: claimed in tasks.md's
  order, and a task left without one is refused naming the scenario and the task that took it.
  A note says which scenario each task took.
- Once a quick change's plan hand-off passes its checks, `atticus change handoff <id> --approve`
  writes `knowledge.yaml`, the org's knowledge its cited ids and words lead to (no model;
  glossary terms the map generated, `term.*`, aren't counted), and says how many items apply,
  that nothing was found, or that no knowledge source is set up. When the index can't be read,
  knowledge.yaml says why (`note`). It rides with a quick change's hand-off only; a staged
  change's knowledge keeps today's route.
- ADR 0207 part 4: a publish step to a new topic may carry `topic` (format, schemaFile, key,
  fields with types, classification, settings). Six rules: `delta.topic-fields`,
  `delta.topic-exists`, `delta.topic-twice`, `delta.topic-classification`, `delta.topic-secret`
  (blocking) and `delta.topic-no-schema` (a note), and `delta.topic-on-step` (blocking) for
  `topic` on any step that isn't a publish to a new topic. design.md gains "Topics this change
  adds", with each listener's standing (read, not read, planned, outside). The architecture and
  fast-path prompts ask for it. In the stories, the publisher's task gets a criterion for the
  schema and one for the settings, and a listener's task the fields it may read. After the build
  the schema file is looked for in the commit's tree (a `schema` claim, as a pipeline's file).
  The flow delta stays version 2; a delta drafted before reads as it did, with only the note.

## build-status.md entry

- v31 WP-05, the quick path's quality: done in `b31/quick-path`. Task checks at the plan
  hand-off (only no criteria blocks; a scenario vouches for one task), knowledge.yaml for a quick
  change. Gate 0's three changes re-run: 6 of 14 tasks refused (A: t2, t4; B: t2, t3, t4; C: t4).
  Known limits, not built: marking a statement about a planned component "planned, unverified"
  in task text (WP-05's third acceptance line); a knowledge item's quote in knowledge.yaml (the
  list has its title and file).
- v31 ADR 0207 part 4, a planned topic's schema: done in `b31/quick-path`: the `topic` key, seven
  rules (in `checkDeltas`: the architecture stage, the fast path, and again on file), the design
  table, both prompts, the stories' task criteria and listener fields, the post-build schema
  file claim, the staged new-topic change in the archetypes test (golden
  `fixtures/stages/new-topic/field-design.md`) and the upgrade test's line.
- The map tools row is PR #6's (merged), not this branch's.

## codebase-map.md lines

- `packages/changes/src/quick-tasks.ts`: a quick change's tasks and their criteria
  (`quickTaskCriteria`), checked with the stories stage's rules (`checkQuickTasks`); called by
  `codeTableState` (`code-table-check.ts`) for the plan hand-off.
- `packages/planner/src/stages/topic.ts`: ADR 0207 part 4, a planned topic's checks
  (`topicIssues`, called by `checkDeltas`), design.md's "Topics this change adds"
  (`renderTopics`, called by `renderArchitecture`), the stories' lines (`topicTaskLines`, called
  by `writeStories`) and the schema file's claim (`topicClaims`, called by `readClaims`).
- `packages/planner/src/stages/knowledge-applies.ts`: `recordQuickKnowledge`, a quick change's
  knowledge list from the index, with no model.
- `packages/cli/src/quick-knowledge.ts`: the hand-off's knowledge line for a quick change, run
  through `handoff`'s `prepare` hook once its checks pass.

## Help and guide text

No new command or flag. For the define-change skill (`packages/assistant-files/starter/skills/
define-change/SKILL.md`, owned by the persona-files builder), under `tasks.md`:

> Each task has its acceptance criteria: indented under its line, one per line, as
> `- Given …, when …, then …` (one says what happens when it fails, if the task takes requests,
> calls another system, publishes or writes data), or its row of `## In the code` names, in
> Spec, a requirement with a scenario no earlier task took: a scenario vouches for one task.
> The plan hand-off refuses a task with neither.
