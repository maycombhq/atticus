# 0041. Small contract additions in M3

- Status: accepted
- Date: 2026-10-18

## Decision

**C4: `GitHost.closePullRequest(repo, number, approval)`.** Closing a pull request without merging it is a write to a shared system, so it takes an approval like every other write (CLAUDE.md rule 6). It returns the pull request as the host now has it. The method is optional on the interface, so Git host plugins written against the first C4 still conform; callers fall back to what they did before (a comment asking a person to close the PR). The mock Git host closes the PR and refuses a merged one. The manual Git host (ADR 0032) makes closing a step for a person, created once per PR and depending on the step that opened it; the PR reads closed once the step is done, so until then it is returned still open. Return to PO (ADR 0029) comments on the hand-off PR, then closes it where the host can, and reports `closedOnHost` from the state the host returns.

**C5: `AiRequest.outputIn?: "run"`.** In hand-off mode an answer a command reads back (critic lens findings, the story writer's prose) is written inside the run's own folder under `.runs/`, not in the change folder, so a second round at the same gate never picks up the first round's answer and the answer never collides with the file the command writes from it. The field is optional; runtimes and callers that leave it out behave as before. With it, `atticus critic --mode hand-off` records each AI lens as waiting with its run; `atticus handoff done <run>` (or `atticus critic --resume`) reads the answer with the critic's own parser and recomputes the round, and the lifecycle refuses a hand-off while a lens of the newest round is still waiting (reason `lens-waiting`).

No other contract changed in this work. Behaviour that closed ADR 0029, 0036, 0037, 0038 and 0039 "not yet" items, recorded here for the build history:

- **Migrations** (extractor `migrations` 1.1.0): ALTER TABLE ADD, DROP, ALTER, MODIFY, CHANGE and RENAME COLUMN (and DROP TABLE and DROP INDEX) are replayed in migration version order, so Table, Column and IndexConstraint records are the latest state: added columns exist, dropped ones (and the keys and indexes on them) are gone, altered ones carry the new type, nullability and default, and each change adds its line to the column's evidence. A Migration record per file still lists every operation.
- **Change folders through the layout**: `changesDirOf` and `changesRelOf` in core resolve `changes/` under `sources.yaml` `layout.openspec`, used by the change store, workspace, hand-off runtime prompts and outputs, assistant files, task runs, manual steps, critic stats, planner and messages, so a repo adopted with OpenSpec in `.atticus/` keeps every change folder there.
- **Workspace sync** skips in-place repos (urls `.` and `./x`) and leaves the root's `.gitignore` alone when every repo is in place.
- **Spec Kit constitution**: a constitution the team wrote (no Atticus header) is never replaced, even with `--force`; Atticus's rules go into a marked section of it, and broken markers make hand-down refuse with a plain message and change nothing.
- **Drift after every scan**: `atticus scan` runs the three-way drift check for open changes in build or qa after writing the catalog (`--no-drift` turns it off); a quiet rescan writes no new round.
- **Hand-off completions**: `atticus handoff done <run>` finishes a hand-up's code-and-test lens, `feature suggest-names` and `templates draft` started in hand-off mode, parsing the answer as a model run would (answers that aren't change artifacts are checked as YAML instead of with `openspec validate`).
- **Absorb refresh**: `atticus absorb --refresh <id>` and `atticus sources refresh` fetch a linked source again, rewrite its proposal and list source files and items added, removed or changed since the last absorb (absorb's `inventory.json` now records a sha-256 per source file).
- **Federated loose ends** go through merge against our raw facts; an interface that only exists because of them joins the catalog flagged `federated:<id>` when both ends are known, and nothing of ours changes.
- **Archive** rescans: the change's repos are updated where their base clones are here and the estate is scanned again; otherwise the exact commands are printed.
- **Change sync** refreshes the hand-off PR's link and number from the host, so a manual `manual://` link is replaced by the one a person recorded.
- **Mandatory gates**: a gate the platform profile lists in `gates` needs a critic round (and its newest round must pass) before the hand-off that leaves it (reason `critic-round-missing`).
- **Service-desk triggers** are matched by one function in the critic package (`matchServiceRequestTriggers`), used by the snow-drafts-present check and the planner.

## Consequences

Return to PO closes PRs on hosts that can, and leaves a tracked step on the manual host instead of a comment nobody follows up. Plugins that don't implement `closePullRequest` keep working. Tests that walk Forge changes to release now record a passed critic round at the design and release gates, as the Forge profile has always said they are mandatory.
