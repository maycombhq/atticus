# v33 notes: the change path's gates become open items (ADR 0210 part 7)

What the shared files should say for the `b33/item9-change-path` branch. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (Changed)

- **The change path's gates are open items, not refusals (ADR 0210 part 7).** A hand-off goes ahead with open org and team blocking findings and knowledge gaps, a stage's open questions, a mandatory gate the critic hasn't reviewed, the quick path's missing "In the code" table and acceptance criteria, OpenSpec validation's warnings, task branches with commits the change branch lacks, and release PRs stale or not merged; its PR lists them under "Open items", and the person who approves it on the Git host decides them. `atticus change status` lists them under "Open items", `change handoff` without `--approve` says them, and the change's page shows them beside the Raise hand-off button, which they don't hold. A stage no longer stops on a finding its drafts repeated three times, findings a person may accept, a person's own edit that reads but fails its checks (no `--force` needed), a checking round past the limit, a gate with no critic round left, or an assistant's "not relevant" proposal: it is done, keeps what it found in `stage/<stage>.yaml` `openItems`, and its phase's hand-off PR lists them; run again, it checks and reviews what is on file as a stopped stage did. A later stage runs while an earlier gate has only open items. `atticus task run` runs a task its `(after …)` names tasks not yet ticked for, saying so; a cycle or a missing task still refuses. Archive goes ahead with post-release findings and unticked tasks, and records them in its history entry. Still refused: a constitution-layer finding (the ingested-content quarantine rule's gaps among them), an unfinished or failed critic round and a lens still out, a finding file that doesn't read, OpenSpec validation's errors, a missing release PR, a person's edit that doesn't read, and every safety rule.

## CHANGELOG.md (Contracts)

- C4, additive: `GET /api/changes/{id}/status` and `GET /api/release/{id}` (`status`) carry `openItems` (reasons, as `blockers`); a reason may carry `openItem: true`. No field removed. `API_VERSION` not bumped on this branch (see below).
- Not C1/C3/C6: `stage/<stage>.yaml` gains optional `openItems` (planner's StageLoop, additive). `GateStatus` gains optional `goesAhead` and `openItems`.

## docs/build-status.md

The change path's gates become open items (2026-11-24; ADR 0210 part 7; C4 additive). **Works:** one notion, `Reason.openItem` (`asOpenItem`, `splitOpenItems`, `openItemLines` in `changes/src/errors.ts`); `assess` splits the gate's reasons into `blockers` (refusals) and `openItems`; `checkFindings` marks org and team findings and gaps open items and keeps constitution findings, `round-unfinished`, `lens-waiting`, `lens-failed` and `bad-finding` as refusals; `checkMandatoryRounds`, the code table and criteria, `taskBranchReasons`, `releasePrReasons` (stale, not merged; missing stays), `checkStage`'s questions and a stage's `openItems` are open items; the hand-off PR's "### Open items" section; `requireValid` returns warnings as open items and refuses on errors; `archiveChange` records open items and archives with `requireTasksComplete: false`; the CI archive gate says open items as notes; the stage loop's gates go on through one `goOn` (done, `openItems` on the loop, a rerun treated as stopped); `refuseWhileEarlierStuck` ignores open items; `task run` with an `(after …)` wait goes ahead with a note (`openItems` on the preview); `change status`, the hand-off preview, the change page and the stage thread's headline say them. Tests: `changes/test/open-items.test.ts` (10), and updated assertions in 21 existing test files across changes, naysayer, planner, taskrun and cli. **Open:** see below.

## docs/codebase-map.md

- `packages/changes/src/errors.ts`: `Reason.openItem`, `asOpenItem`, `splitOpenItems`, `openItemLines`; reason code `stage-open-item`.
- `packages/changes/src/assess.ts`: `Assessment.openItems`, `Readiness.openItems`; `nextStep` counts open items in "Ready to raise".
- `packages/changes/src/lifecycle.ts`: `checkFindings` (layer decides), `checkMandatoryRounds`, `checkStage` (questions, a stage's `openItems`).
- `packages/changes/src/handoff.ts`: `prBody`'s "### Open items"; `requireValid` returns warnings; `archiveChange` records open items; `untickedTasks`.
- `packages/planner/src/stages/loop.ts`: `WentOn`, `goOn` (a stage's gate goes on), `runStageLoop` → `stageLoop`.
- `packages/planner/src/stages/schema.ts`: `StageLoop.openItems`.
- `packages/naysayer/src/gates.ts`: `GateStatus.goesAhead`, `GateStatus.openItems`.
- `packages/taskrun/src/run.ts`: `refuseIfAfterHolds` returns the open item; `TaskRunPreview.openItems`.
- `packages/ui/src/screens/Changes.tsx`: the Open items list beside Raise hand-off.

## Copy words added (packages/ui/src/copy.ts, `changes`)

- `openItems`: "Open items"
- `openItemsSaid(n)`: "1 open item goes with the hand-off: its PR lists it, and the person who approves it decides." / "N open items go with the hand-off: its PR lists them, and the person who approves it decides."

Server-side words (inline, as their neighbours): the PR's "### Open items" lead line; `change status` "Open items (the hand-off's PR lists them; its approver decides them):"; the hand-off preview's "Open items, which the PR lists for the person who approves it:"; "Ready to raise "…": its PR lists N open items for the person who approves it."; the stage's "went on" messages; the stage thread's "The stage went on: …"; the cockpit's "has open findings, which its hand-off's PR would list as open items for its approver"; `task run`'s "Open item: task X runs before what it names in (after …): …"; archive's "Archived with open items: …"; `act`'s waivable:false refusal adds "or hand off with it: the hand-off's PR lists it as an open item".

## Found and not done

- A constitution rule's knowledge gap (e.g. an owner unknown) is a constitution-layer finding, so it still stops a hand-off, as the ADR says; it is common, so this may surprise people. Kept blocking (a safety rule when unsure).
- A drafting finding of a constitution critic rule repeated three drafts lets the stage go on; its hand-off is still refused by the same finding on the gate.
- An updated hand-off PR (changes requested, then raised again) doesn't rewrite its body, so its Open items are those of the first raise; the Git host adapter has no body update used here.
- `raiseReleasePrs` still skips a repo whose task branches aren't merged (no release PR without the tasks' code); only the go/no-go assessment treats it as an open item.
- The Build hand-off still waits for every task ticked (`nextStep`), which the ADR doesn't list.
- `runCritic`'s own round-limit refusal stays (nothing to run); the stage goes on past it.
- `GateStatus.mayProceed` keeps its meaning (nothing open at the gate) and `atticus critic`'s exit code with it; `goesAhead` says whether the hand-off goes ahead.
- `API_VERSION` (3.20.0) is not bumped and `docs/api/openapi.json` not regenerated: the new fields aren't in core's zod contracts; the integrator bumps the minor with the other v33 items.
- The cockpit (`atticus next`) still offers a gate's finding as the step before the hand-off; it now says the hand-off would go ahead with it.
- Phase.tsx's gate header (Know › Phase) and Release.tsx don't list open items yet; Changes.tsx does. No UI test added for the list.
