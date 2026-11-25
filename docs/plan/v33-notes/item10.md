# v33 notes: item 10, one command (ADR 0210 part 8)

What the shared files should say for the `b33/item10-sync` branch. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (beta.33, Added)

- **`atticus sync`: from a repo to a drawn map in one command (ADR 0210 part 8).** It finds the repos whose clone moved past their facts or were never read (`map --all`'s plan), reads them recipe first and the model for the rest (`map --all`'s model read, unattended; AI off, the recipes only, and what only the model reads is said to wait), writes the catalog once (`verify --all --write`: one build, one undo step, item 4's pairing inside it), then says the loose calls, the rejected facts with why, the open questions and the one next step. Nothing changed: no prompt, nothing written, "Up to date". It never prompts; past `budgets.limits` it stops before its first request (item 6). `--json` for CI: `{ upToDate, read: [{ repo, by: recipe|model|carry }], waiting, written, rejected: [{ repo, code, message, id? }], removed, loose, open, next }`.

## CHANGELOG.md (beta.33, Changed)

- **`atticus help`'s first page leads with `atticus sync`.** It lists ten commands: `sync`, `init`, `change`, `critic`, `stories`, `task`, `questions`, `knowledge`, `next`, `ui`. `map`, `verify` and `join` move under `atticus legacy` and run exactly as before. The command catalogue marks them `legacy: true`; VS Code's and IntelliJ's command lists follow it.
- **The app's Apply runs `atticus sync`** (`POST /api/facts/apply-all`, `syncCommand` with `apply`): what changed is read first, then the repos listed (or all read) are written, with the same per-repo progress, Stop and result as before. VS Code's Atticus: Sync the map (the `atticus.mapEstate` command, retitled) and IntelliJ's Tools → Atticus → Map the Estate run `atticus sync` in a terminal/console, with no limit to type.
- **`map --all`'s estate join is `verify --all --write`'s own run** (one build, the pairing inside it), not a loop of its own: about 70 lines of duplicated orchestration gone. Its lines are verify --all's ("Run it once that is put right: atticus verify <repo> --write", "Stopped after N of M repos. Not applied: …"); Ctrl+C reaches it through `withSignal`. Its summary's link counts are the reads' own.

## CHANGELOG.md (beta.33, Contracts)

- None. `atticus commands --json` marks map, verify and join `legacy: true` (an existing field's value). `MapAllOptions.join?: false` is internal.

## docs/build-status.md

`atticus sync` (2026-11-25; ADR 0210 part 8). **Works:** `packages/cli/src/sync-command.ts` (`syncCommand`, `syncHooks`) composes `planEstate`, `mapAllCommand` (model mode, `join: false`), `recipeStep` (AI off), `verifyAllCommand` (one write, pairing inside), `rejectionsOf`, `pairAsk` with AI off (the loose calls, no model asked) and `listQuestions`. Main's `sync` group, the help's line, TOP_WORDS/TOP_COMMANDS. The Apply route through it. Tests: `cli/test/sync.test.ts` (7: only the changed repo read, written once and summarised; up to date writes nothing and sends no prompt; AI off recipes only; AI on the model reads the rest; --json shape; help's first page; the Learn seam), updated `map-loop-count`, `top-commands`, `cli`, `export-commands`, `jobs-hear-stop`, VS Code `beta10` and `commands`. **Open:** see below.

## docs/codebase-map.md

- `packages/cli/src/sync-command.ts` (new): `syncCommand`, `SyncOptions` (`json`, `maxTokens`, `apply`, verify --all's `onStart`/`onRepo`/`onStopped`), `syncHooks.learn`.
- `packages/cli/src/map-all.ts`: `MapAllOptions.join`; the join calls `verifyAllCommand`; `commitOf` and `rejectionsOf` exported.
- `packages/cli/src/ui-api-steps.ts`: `POST /api/facts/apply-all` runs `syncCommand`.
- `packages/cli/src/top-commands.ts`: `TOP_WORDS` (ten, sync first), `TOP_HELP`.
- `packages/vscode/src/jobs.ts`: `atticus.mapEstate` runs `["sync"]`. `packages/intellij/.../ide/EstateActions.kt`: `MapEstateAction` runs `atticus sync`.

## Found and not done

- **Learn after the write (item 5b, PR #26) is a seam, not wired.** `syncHooks.learn(root, types, io)` is called once, after a write, with the repo types this sync read. When PR #26 merges, set it to `learnRecipes` with a `types` filter (learnRecipes already proves each active recipe with `proveRecipe` first and asks the model only on a diff, or for a type with no recipe and three or more read repos). Its own `planRun` is a second plan, not folded into the read's single plan; folding it in needs `learnRecipes` to return its plan before running.
- "Open items" in the summary are the open questions; the change path's open items (item 9) are per change and not listed by sync.
- A model read under `map --all` still writes each repo as it verifies it (its parts' own `verify --write`), then sync writes once over all; only the join's duplicate loop is gone.
- Human output doesn't list the removed records itself: verify --all's own lines say each with why; `--json` carries `removed`.
- `atticus sync` exits with verify --all's code (1 when a repo has rejected facts or wasn't applied), as Apply did.
- The IntelliJ change wasn't compiled here (Gradle offline); `Commands.mapAllArgv`/`runtimeMaxInput` stay (tested, now unused by the action).
- `TOP_HELP`'s and the comments' "twelve" wording is left where it isn't user-facing.
