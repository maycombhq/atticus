# 0119. One experience on every surface: the app, both editors, the command line and the assistant's commands (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0015 (the local server), 0073 (one navigation for everyone), 0086 (slash commands for each step), 0090 (the chat participant), 0091 and 0097 (the app in a VS Code tab), 0096 (every command as data), 0099 (the IntelliJ plugin), 0104 (the Claude Code plugin and MCP), 0105 (the menu in the order of a working day)

## Context

People reach Atticus through five surfaces: the web app (`atticus ui`), the VS Code extension, the IntelliJ plugin, the `atticus` command line, and the `/atticus-*` commands their assistant runs (Copilot or Claude Code, plus the MCP server). At the bank, the main way of working is Copilot with the slash commands, with the app open beside it.

A review of every surface against six questions (can a new person start; can they tell what to do next; does the surface tell the truth about state; are the words plain; does it work the same everywhere; is it safe) found the foundations sound. There is one copy file with a test, every screen has loading, error and empty states, there are axe checks in both themes, the server is localhost-only with a token, and `next` is offered everywhere. The problems are in the seams between surfaces. The worst:

- The app only refreshed live inside VS Code. The server sent `file.changed` only for its own writes, and VS Code fed its panel from its own watcher. In a browser or in IntelliJ's panel, what an assistant or the CLI wrote never reached the screen until a reload.
- `POST /api/jobs/{id}/cancel` existed but nothing could stop: the jobs had no way to hear it, and no screen offered it.
- The CLI ignored misspelled flags (`--aprove`), including on commands that write.
- The slash-command lists differed between the generated files, the app and the plugin README, and nine AI steps had none.
- Ids were typed by hand where a picker existed, messages said "It exited 2", and settings had to be edited as YAML.
- `atticus ui` printed the session token into every terminal.

## Decision

These rules hold for every surface, today's and future ones. Each item is built as its own ticket, in the order below.

### 1. State tells the truth everywhere

- **The server follows the metarepo's files** (`packages/server/src/watch.ts`). It watches the folders Atticus keeps its files in: the org pack, the catalog, OpenSpec, specs, questions, knowledge, proposals, inputs, the model runs and `.atticus/history`. Each changed path is sent as a `file.changed` live event, coalesced over 300 ms. More than 50 paths at once are sent as their top folders.
- It never follows the base clones, the index, Git or `node_modules`. Those change while the app reads, and following them would make the app read again for nothing.
- A folder made after start is followed from then on. `startServer({ watch: false })` turns it off. `RunningServer.following` lists what is followed.
- The browser and IntelliJ's panel now update as VS Code's does. VS Code's bundled panel, which hears events from the extension, also follows proposals, inputs, the model runs and the history.
- **Every screen follows file changes.** `useReloadOnFiles(...views)` in the app's client reads a screen's data again on `file.changed`, `run.changed` or `index.rebuilt`. Explore, Questions, Learning, Settings and Across now use it, as the other screens already did.
- **Cancel stops the work.** A job runs inside an abort signal (`withSignal`, `currentSignal`, `throwIfCancelled` in `@maycombhq/core`).
  - The model runtime uses the job's signal when it isn't given one, so a model call stops at once and the run is recorded as cancelled.
  - The scan checks between repos, before anything is written.
  - A cancelled job ends as `cancelled`, not `failed`.
  - The Scans panel and a step run on the server (Run with the model) show Cancel while they run. Copilot's own chat has its own stop.
- **Plain words for job states and errors.** The Scans panel says a job's state in words and lists each error on its own line.
- **No silent failures in VS Code.**
  - A failed read of a change's tasks says so, with Show the output; before, it was shown as "no tasks".
  - Lenses that can't be read say why in the output, once per reason.
  - The startup health check's own failure is written to the output.
- **The token stays out of scrollback.** `atticus ui` prints the session token only when an editor started it (`--embed`, `--parent`; both read it from that line) or with `--show-token`. Otherwise it says how to get it.

### 2. A command line that catches mistakes and explains itself

- Unknown flags are refused with a did-you-mean, built from the command catalogue.
- `atticus help [command]` is added, and a misspelled command gets a did-you-mean.
- Help is grouped by area, with commands for Atticus's own developers behind `--all`.
- One word means one thing. Old names stay as aliases for two versions and print the new name.
- A command run outside a metarepo says so and names `init` and `adopt`. `next` names the person's own assistant.
- `doctor` checks that the model can be reached, that the slash-command files are current, and the MCP and editor setup.

### 3. One assistant command set, checked

- One list in `@maycombhq/assistant-files`. The app, the plugin README, the VS Code chat participant, IntelliJ's hints and the guides are generated from it or tested against it.
- The old `/atticus-plan`, `/atticus-snow` and `/atticus-critic` are rewritten to the current layout.
- The AI steps that have no command get one.
- Every prompt starts with the "not a metarepo / CLI missing / files stale" check.
- The MCP tools say `readOnlyHint`.

### 4. No ids by hand, no CLI words, no terminal surprises

- **Pickers** wherever a person names a change, a repo or a flow.
- **One runner** with progress and Cancel, never a terminal for an Atticus step.
- **Words from the copy files**:
  - the step's own sentence instead of an exit code;
  - VS Code's words in one file, with the app's "no English in code" test.
- **Forms instead of YAML**: repos, the org pack's owner, wiki sources (Confluence and SharePoint included) and the model.
- **Run the step again** after an answer.
- **At most one startup notice**, with "Don't show again".

### 5. Words and the map

- **One shape on every surface**: Home → Changes → Knowledge → Estate → Set up, then Atticus itself.
  - The phase screens become tabs of one change.
  - More goes away.
  - One name per thing.
  - Old routes still resolve (ADR 0105).
- **A product glossary**: one plain sentence per term, shown where the term is first used and by `atticus explain <term>`.
- **The tour** gets six steps and takes focus.
- **Breadcrumbs** on every change-scoped screen.
- **No raw keys or JSON** on screen.
- **Focus moves** to the page on a route change.
- **The axe check** also fails on moderate issues.

### 6. IntelliJ as a peer

- Steps run from the IDE.
- Native Waiting and Changes trees, answering, a status bar widget, a file watcher, background progress and confirmations.
- A parity test against the command catalogue and the VS Code extension.

### 7. Features that raise the value

The change cockpit, evidence beside a question, the code's flows and changes in the editor, a hand-off PR that reviews itself, watch and nudge, start from a similar change, a system page, a review mode for knowledge, undo for recorded decisions, bulk actions on Waiting, and a guided first hour. Each is its own ticket, with an ADR where it touches a contract.

Choosing the assistant and the model from the app, branches, and the knowledge files people drop into the metarepo's `inputs/` (never folders inside the code repos) each have an ADR of their own.

## Consequences

- What an assistant writes reaches every open screen in about a second, wherever the app is open.
- A cancelled scan or step stops and says so. Work that doesn't run inside a job (the CLI in a terminal) is unchanged: Ctrl+C stops it as before.
- A watcher can fail (too many folders for the OS, a network drive). The watcher keeps why (`MetarepoWatch.problems`), and the app still works by reload.
- `atticus ui` no longer prints the token by default. A script that read it from a plain `atticus ui` passes `--show-token`.
- C4 (local API) gains no route for item 1. The live events are the same `file.changed` events, now also sent for writes the server didn't make.

## Built

- Item 1, all of it. Added after a real run: the server keeps the catalog it read in memory and forgets it on any file change it hears (a change's page from 7 s to about 1 s on 1,537 records).
- Item 2, in part: unknown flags refused with the nearest one (`packages/cli/src/flags.ts`, checked against the options `main.ts` parses, the questions command's own, `--handoff` and every flag the help names); `atticus help [command]` and `<command> --help` (`help-commands.ts`); the nearest command for a misspelled one. Grouped help by area, with Atticus's own quality commands under `--all` (`groupedHelp`). `doctor` says how AI steps run (model mode's provider and key variable, by name, with no call: doctor stays offline) and whether the slash-command files are current. Still to build: aliases for one word per thing, the "not a metarepo" check, `next` naming the assistant.
- Item 5, in part (the app): six sections (`SECTIONS` in `ui/src/app/screens.ts`), every page a tab of one (`SectionTabs`, with where you are and a change's tabs grouped by phase, keeping the change), no More, unknown addresses open Home, the confusing names changed. Not built yet: Set up shown before Knowledge until the catalog is baselined; Home as one page (Waiting on you and Overview are its two tabs for now); the product glossary; the six-step tour; focus on route change; axe at moderate; the editors' sidebars in the same order.
- Item 4, in part (VS Code): pickers for the canvas, the Change diagram and the Estimate; one startup notice with Don't show again (`startupNotice`, kept in `globalState` by the set's signature); exit codes said in words (`WORDS.endedWith`); results that start with what was said; Run the next step after an answer; a numbered practice folder (`freeFolder`). Not built yet: one runner for every step (no terminal), forms in place of YAML, the IntelliJ pickers, moving every inline VS Code string into `words.ts` with a test.
- Item 3, in part: one list (`metarepoCommands`), with a parity test against the app, the plugin README (generated), the roles guide and IntelliJ; `/atticus-draft`, `/atticus-knowledge-ask` and `/atticus-critic` (the lenses with `--handoff`); `/atticus-snow` and `/atticus-release` rewritten to run the commands; `/atticus-plan` kept as the old name of `/atticus-stories`; `readOnlyHint` on every MCP tool. Not built: the check at the start of every prompt (with item 2's "not a metarepo"); slash commands for `scan review`, `onboard`, `orgpack draft`, `tests generate` and `feature suggest-names`, which don't take `--handoff` yet; MCP tools for `ask` and `knowledge ask`.

## Addendum (2026-10-26): the record cache belongs to the root the command is working in

### Context

The record cache (`packages/core/src/record-cache.ts`) keeps each parsed record file in `.atticus/cache/` so `atticus next` and `change status` don't parse 1,500 files on every run. It picked where to keep them itself: `memoFileOf` called `metarepoRootOf(dir)`, the nearest folder above the files holding `org-pack/` or `.atticus/org-pack/` — the metarepo **that contains the folder being read**.

For our own catalog, specs and knowledge that is the right folder. For someone else's it is their repository. `atticus absorb`, a federated scan and a linked estate all read another team's metarepo, and each of them wrote `.atticus/cache/<kind>-<key>.json` and `.atticus/.gitignore` into it. It showed up in two committed fixtures after a test run, and absorb then listed our own cache as content of theirs to translate, which took a measured bar from 100% to 88.9%. The pollution was the lesser half: Atticus never writes where it was only asked to read (hard rule 6; ADR 0038: nothing else is written into a product repo).

### Decision

1. **The caller names the root; nothing works one out.** `readParsedFiles` takes `cacheRoot`, the metarepo this run is working in, and keeps the parses at `<cacheRoot>/.atticus/cache/` and nowhere else. `metarepoRootOf` is gone: no reader looks at the folder it is reading to decide where to write. The key is still the folder's absolute path, and the memo still names that folder, so several folders cached into one root can't be read as one.

2. **No root means no cache — read-only.** A read with no `cacheRoot` reads nothing from a cache and writes nothing anywhere; it costs the parse and that is all. That is the safe default, so a path nobody thought about is read-only rather than quietly writing somewhere. This is why the choice is an explicit parameter and not a root the CLI records for the run in global state: a hidden root is a default again, and the next read-only path added would inherit it.

3. **Threaded through every reader that keeps parses.** `readRepoSpec` (`core/specs.ts`), `readCatalog` (`scanner/files.ts`) and `readKnowledge` (`knowledge/knowledge-store.ts`) each take `cacheRoot` and pass it down, defaulting to none. The commands pass the root they were given (`--root`). Two paths name no root on purpose: `atticus catalog diff <a> <b>`, whose two folders are given on the command line and may be anyone's, and the reading bench, which reads its own cache folder.

4. **Their files, our cache.** A federated scan reads their catalog with `cacheRoot` set to **our** root, so the saving holds for records we read from a linked estate while their folder stays untouched. Where the parses are kept follows the command, not the files.

### Consequences

- Reading another metarepo leaves it byte-identical. `packages/adopt/test/read-only.test.ts` fingerprints a whole source metarepo — every file, its path and its bytes, and every folder — before absorb, a federated scan and the conflict check, and compares after; the M3 absorb bar does the same through the CLI for all five source fixtures.
- A new reader that forgets `cacheRoot` loses the saving. It cannot pollute anything, and the perf budgets in `packages/m5-exit/test/perf-commands.test.ts` are what catch the loss.
- The cache stays local-only and git-ignored (`LOCAL_ONLY`, `cache/`), and `absorb` still skips `.atticus/` as local-only content.
