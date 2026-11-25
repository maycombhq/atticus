# v33 notes: item 10, one command (ADR 0210 part 8)

What the shared files should say for the `b33/item10-sync` branch. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (beta.33, Added)

- **`atticus sync`: from a repo to a drawn map in one command (ADR 0210 part 8).** It finds the repos whose clone moved past their facts or were never read (`map --all`'s plan), reads them recipe first and the model for the rest (`map --all`'s model read, unattended; AI off, the recipes only, and what only the model reads is said to wait), writes the catalog once (`verify --all --write`: one build, one undo step, item 4's pairing inside it), then says the loose calls, the rejected facts with why, the open questions and the one next step. Nothing changed: no prompt, nothing written, "Up to date". It never prompts; past `budgets.limits` it stops before its first request (item 6). `--json` for CI: `{ upToDate, read: [{ repo, by: recipe|model|carry }], waiting, written, rejected: [{ repo, code, message, id? }], removed, loose, open, next }`.

## CHANGELOG.md (beta.33, Changed)

- **`atticus help`'s first page leads with `atticus sync`.** It lists ten commands: `sync`, `init`, `change`, `critic`, `stories`, `task`, `questions`, `knowledge`, `next`, `ui`. `map`, `verify` and `join` move under `atticus legacy` and run exactly as before. The command catalogue marks them `legacy: true`; VS Code's and IntelliJ's command lists follow it.
- **The app's Apply is unchanged** (review of PR #27): it writes only the repos it lists through `verify --all --write`, never reads and never calls a model. VS Code's Atticus: Sync the map (the `atticus.mapEstate` command, retitled) and IntelliJ's Tools → Atticus → Map the Estate run `atticus sync` in a terminal/console, with no limit to type.
- **`map --all`'s estate join is `verify --all --write`'s own run** (one build, the pairing inside it), not a loop of its own: about 70 lines of duplicated orchestration gone. Its lines are verify --all's ("Run it once that is put right: atticus verify <repo> --write", "Stopped after N of M repos. Not applied: …"); Ctrl+C reaches it through `withSignal`; the summary's rejected count is read back after the join. Under sync (`join: false`) a model read verifies each repo without writing it (`write: o.join !== false`), so the whole sync is one build, one undo copy and one pairing.
- **`verify --all` says a repo the file system kept from being applied (or verified) as "N not applied (…)"**, apart from "with something to fix".
- **`learnRecipes` takes `types`** (only these repo types); sync passes the types it read and the job's signal. Learn proves each active recipe first and plans the model (its own `planRun`) only when a recipe fails or a type of three or more read repos has none.
- **Dead editor code removed:** VS Code's limit box for Map the estate (`runtimeMaxInput`, `limitOf`, the `limit` need, its words) and IntelliJ's `Commands.mapAllArgv`/`runtimeMaxInput`, with their tests.

## CHANGELOG.md (beta.33, Contracts)

- None. `atticus commands --json` marks map, verify and join `legacy: true` (an existing field's value). `MapAllOptions.join?: false` is internal.

## docs/build-status.md

`atticus sync` (2026-11-25; ADR 0210 part 8). **Works:** `packages/cli/src/sync-command.ts` (`syncCommand`) composes `planEstate`, `mapAllCommand` (model mode, `join: false`), `recipeStep` (AI off), `verifyAllCommand` (one write, pairing inside), `learnRecipes` (the types read), `rejectionsOf`, `pairAsk` with AI off (the loose calls, no model asked) and `listQuestions`. Main's `sync` group (Ctrl+C), the help's line, TOP_WORDS/TOP_COMMANDS. Tests: `cli/test/sync.test.ts` (11: only the changed repo read, written once and summarised; up to date writes nothing and sends no prompt; AI off recipes only; AI on the model reads the rest; two moved clones one build and one undo copy; Stop before the read; Apply reads nothing and writes only its repos; Learn proves and asks no model; Learn's one line; --json with --max-tokens; help's first page), updated `map-loop-count`, `verify-files-unchanged`, `top-commands`, `cli`, `export-commands`, VS Code `beta10` and `commands`. **Open:** see below.

## docs/codebase-map.md

- `packages/cli/src/sync-command.ts` (new): `syncCommand`, `SyncOptions` (`json`, `maxTokens`); deps `runtime`, `git`, `learnRunner`. Main wires Ctrl+C to an AbortController through `withSignal`; sync passes `currentSignal()` to map --all and Learn.
- `packages/cli/src/map-all.ts`: `MapAllOptions.join`; the join calls `verifyAllCommand`; `commitOf` and `rejectionsOf` exported.
- `packages/cli/src/verify-commands.ts`: verify --all's "not applied" count. `packages/cli/src/learn-recipes.ts`: `types`.
- `packages/cli/src/top-commands.ts`: `TOP_WORDS` (ten, sync first), `TOP_HELP`.
- `packages/vscode/src/jobs.ts`: `atticus.mapEstate` runs `["sync"]`. `packages/intellij/.../ide/EstateActions.kt`: `MapEstateAction` runs `atticus sync`.

## Found and not done

- Learn keeps its own `planRun` (a second plan after the read's), run only when the model is needed; folding it into the read's one plan would need `learnRecipes` to return its plan first. Learn says nothing when every recipe holds (only its refusal, or what it asked, is a line).
- "Open items" in the summary are the open questions; the change path's open items (item 9) are per change and not listed by sync.
- A model read under `map --all` still writes each repo as it verifies it (its parts' own `verify --write`), then sync writes once over all; only the join's duplicate loop is gone.
- Human output doesn't list the removed records itself: verify --all's own lines say each with why; `--json` carries `removed`.
- `atticus sync` exits with verify --all's code (1 when a repo has rejected facts or wasn't applied). The app's separate read jobs (Sync, read and apply N; the Copilot run) are not routed through sync: they are copilot-acp reads a person starts, not Apply.
- The IntelliJ change wasn't compiled here (Gradle offline); `Commands.mapAllArgv`/`runtimeMaxInput` stay (tested, now unused by the action).
- `TOP_HELP`'s and the comments' "twelve" wording is left where it isn't user-facing.
