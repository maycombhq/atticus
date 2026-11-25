# v33 notes: the change path's gates become open items (ADR 0210 part 7)

What the shared files should say for the `b33/item9-change-path` branch. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (Changed)

- **The change path's gates are open items, not refusals (ADR 0210 part 7).** A hand-off goes ahead with open org and team blocking findings and knowledge gaps, a stage's open questions, a mandatory gate the critic hasn't reviewed, the quick path's missing "In the code" table and acceptance criteria, OpenSpec validation's warnings, task branches with commits the change branch lacks, and release PRs stale or not merged; its PR lists them under "Open items", and the person who approves it on the Git host decides them. `atticus change status` lists them under "Open items", `change handoff` without `--approve` says them, and the change's page shows them beside the Raise hand-off button, which they don't hold. A stage no longer stops on a finding its drafts repeated three times, findings a person may accept, a person's own edit that reads but fails its checks (no `--force` needed), a checking round past the limit, a gate with no critic round left, or an assistant's "not relevant" proposal: it is done, keeps what it found in `stage/<stage>.yaml` `openItems`, and its phase's hand-off PR lists them; run again, it checks and reviews what is on file as a stopped stage did. A later stage runs while an earlier gate has only open items. `atticus task run` runs a task its `(after …)` names tasks not yet ticked for, saying so; a cycle or a missing task still refuses. Archive goes ahead with post-release findings and unticked tasks, and records them in its history entry. Still refused: a constitution-layer finding (the ingested-content quarantine rule's gaps among them), an unfinished or failed critic round and a lens still out, a finding file that doesn't read, OpenSpec validation's errors, a missing release PR, a person's edit that doesn't read, and every safety rule.

- **An approval approves the open items it saw (review of PR #21).** A raised hand-off records the open items its PR shows (`change.yaml`, the hand-off's `openItems`); an update rewrites the PR body's Open items where the Git host can and says them in its update comment; at merge, open items the PR hasn't shown are posted on it and the merge waits for an approval given after them (`open-items-changed`, then `open-items-unseen`). A merge's history entry keeps the open items it went ahead with, and the archive's entry keeps every open item the change carried. A gate's status line says a gate with only open items goes ahead, not that it is closed. The Phase gate, the Release page, the change's page, the VS Code Atticus view (an Open items row under the change) and IntelliJ's Changes tab list them.

## CHANGELOG.md (Contracts)

- C4, additive: `GET /api/changes/{id}/status` and `GET /api/release/{id}` (`status`) carry `openItems` (reasons, as `blockers`); a reason may carry `openItem: true`. No field removed. `API_VERSION` not bumped on this branch (see below).
- C4, change.yaml (the change state file) version 2: a hand-off's optional `openItems: { items, afterReview }` and a history entry's optional `openItems`. A version 1 file reads as it is (the migration is the number only); a file is written at 2 only once it carries open items (`changeSchemaVersionFor`, in `serializeChange` and the record merge), so a change without any stays at 1 and an older beta keeps reading it; a version 1 file carrying them is refused ("openItems needs schemaVersion 2 (ADR 0210)"). No `atticus upgrade` step: Atticus writes change.yaml itself, and nothing has a change file to lift. `docs/spec/contracts/c4-plugins-workspace-and-api.md` and `docs/api/openapi.json` regenerated.
- C4, additive: GitHost's optional `updatePullRequest(repo, number, { body }, approval)` (the mock has it; the manual host doesn't, so it gets the comment only); `atticus change status --json` carries `openItems`.
- Not C1/C3/C6: `stage/<stage>.yaml` gains optional `openItems` (planner's StageLoop, additive). `GateStatus` gains optional `goesAhead` and `openItems`.

## docs/build-status.md

The change path's gates become open items (2026-11-24; ADR 0210 part 7; C4 additive). **Works:** one notion, `Reason.openItem` (`asOpenItem`, `splitOpenItems`, `openItemLines` in `changes/src/errors.ts`); `assess` splits the gate's reasons into `blockers` (refusals) and `openItems`; `checkFindings` marks org and team findings and gaps open items and keeps constitution findings, `round-unfinished`, `lens-waiting`, `lens-failed` and `bad-finding` as refusals; `checkMandatoryRounds`, the code table and criteria, `taskBranchReasons`, `releasePrReasons` (stale, not merged; missing stays), `checkStage`'s questions and a stage's `openItems` are open items; the hand-off PR's "### Open items" section; `requireValid` returns warnings as open items and refuses on errors; `archiveChange` records open items and archives with `requireTasksComplete: false`; the CI archive gate says open items as notes; the stage loop's gates go on through one `goOn` (done, `openItems` on the loop, a rerun treated as stopped); `refuseWhileEarlierStuck` ignores open items; `task run` with an `(after …)` wait goes ahead with a note (`openItems` on the preview); `change status`, the hand-off preview, the change page and the stage thread's headline say them. Tests: `changes/test/open-items.test.ts` (14), `cli/test/open-items-status-line.test.ts`, `ui/test/open-items.test.tsx`, `vscode/test/open-items.test.ts`, the IntelliJ `ViewsTest`, two in `ci/test/archive.test.ts`, and updated assertions in 21 existing test files across changes, naysayer, planner, taskrun and cli. **Open:** see below.

## docs/codebase-map.md

- `packages/changes/src/errors.ts`: `Reason.openItem`, `asOpenItem`, `splitOpenItems`, `openItemLines`; reason code `stage-open-item`.
- `packages/changes/src/assess.ts`: `Assessment.openItems`, `Readiness.openItems`; `nextStep` counts open items in "Ready to raise".
- `packages/changes/src/lifecycle.ts`: `checkFindings` (layer decides), `checkMandatoryRounds`, `checkStage` (questions, a stage's `openItems`).
- `packages/changes/src/handoff.ts`: `prBody`'s "### Open items"; `requireValid` returns warnings; `archiveChange` records open items; `untickedTasks`.
- `packages/planner/src/stages/loop.ts`: `WentOn`, `goOn` (a stage's gate goes on), `runStageLoop` → `stageLoop`.
- `packages/planner/src/stages/schema.ts`: `StageLoop.openItems`.
- `packages/naysayer/src/gates.ts`: `GateStatus.goesAhead`, `GateStatus.openItems`.
- `packages/taskrun/src/run.ts`: `refuseIfAfterHolds` returns the open item; `TaskRunPreview.openItems`.
- `packages/ui/src/app/open-items.tsx` (new): `OpenItems`, used by `screens/Changes.tsx` (exports `Detail` for its test), `screens/know/Phase.tsx` and `screens/run/Release.tsx`.
- `packages/changes/src/handoff.ts`: `openItemMessages`, `openItemsComment`; `syncHandoff`'s open-items check (`open-items-changed`, `open-items-unseen`).
- `packages/core/src/schema/change.ts`: `CHANGE_SCHEMA_VERSION` 2, `changeSchemaVersionFor`, `ChangeHandoff.openItems`, `ChangeHistoryEntry.openItems`.
- `packages/adapters/src/git-host.ts`: `GitHost.updatePullRequest?`, `MockGitHost.updatePullRequest`.
- `packages/cli/src/critic-commands.ts`: `statusLine` for a gate whose open findings are all open items.
- `packages/vscode/src/sidebar-data.ts`: `openItemsNode`, `openItemRows` (the change's Open items row).
- `packages/intellij/.../core/Views.kt`: `ChangeRow.openItems`, read by `Changes.withStatus`; `ide/Views.kt` lists them under the change.

## Copy words added (packages/ui/src/copy.ts, `openItems`)

- `title`: "Open items"
- `said(n)`: "1 open item goes with the hand-off: its PR lists it, and the person who approves it decides." / "N open items go with the hand-off: its PR lists them, and the person who approves it decides."
- `none`: "No open items: nothing goes with the hand-off for its approver to decide."
- IntelliJ `Copy.openItemsLine(n)`: "N open items for its hand-off's approver"; `Copy.openItem(m)`: "Open item: m".

Server-side words (inline, as their neighbours): the PR's "### Open items" lead line; `change status` "Open items (the hand-off's PR lists them; its approver decides them):"; the hand-off preview's "Open items, which the PR lists for the person who approves it:"; "Ready to raise "…": its PR lists N open items for the person who approves it."; the stage's "went on" messages; the stage thread's "The stage went on: …"; the cockpit's "has open findings, which its hand-off's PR would list as open items for its approver"; `task run`'s "Open item: task X runs before what it names in (after …): …"; archive's "Archived with open items: …"; `act`'s waivable:false refusal adds "or hand off with it: the hand-off's PR lists it as an open item".

## Found and not done

- A constitution rule's knowledge gap (e.g. an owner unknown) is a constitution-layer finding, so it still stops a hand-off, as the ADR says; it is common, so this may surprise people. Kept blocking (a safety rule when unsure).
- A drafting finding of a constitution critic rule repeated three drafts lets the stage go on; its hand-off is still refused by the same finding on the gate.
- `raiseReleasePrs` still skips a repo whose task branches aren't merged (no release PR without the tasks' code); only the go/no-go assessment treats it as an open item.
- The Build hand-off still waits for every task ticked (`nextStep`), which the ADR doesn't list.
- `runCritic`'s own round-limit refusal stays (nothing to run); the stage goes on past it.
- `GateStatus.mayProceed` keeps its meaning (nothing open at the gate) and `atticus critic`'s exit code with it; `goesAhead` says whether the hand-off goes ahead.
- `API_VERSION` (3.20.0) is not bumped; the integrator bumps the minor with the other v33 items.
- The cockpit (`atticus next`) still offers a gate's finding as the step before the hand-off; it now says the hand-off would go ahead with it.
- A Git host plugin without `updatePullRequest` (and the manual host) keeps the first raise's PR body; the update comment carries the current list there.
- The IntelliJ change wasn't compiled here (Gradle can't resolve its plugins offline); its test is in `ViewsTest.kt`.
- `cli/test/ui-api-setup.test.ts` ("turns AI decides on…") fails on origin/main as merged (expects runtime.yaml schemaVersion 4, gets 5); not this branch's.
- `conformance/test/size-budget.test.ts` is over on origin/main (this branch adds about 390 net source lines of the 1,770 over) and `npm-layout.test.ts` fails there on `re2js`'s types; neither is fixed here.
