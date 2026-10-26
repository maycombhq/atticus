# 0100. Everything from the plugin, guided: start, onboard, bring in, accept

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0038 (init, adopt, absorb, federation), 0096 (every command in the editor), 0098 (the extension for a first-time user)

## Context

The extension was driven in a real VS Code on Windows (Playwright on VS Code's own Electron, its own profile, the packaged extension) from an empty window to an onboarded repo. These problems came up:

- In an empty window, the Next section was too small to show its welcome. Only **Open a metarepo** showed, and Create, Use Atticus in this repo and the practice metarepo sat behind a scrollbar.
- Once a metarepo was open, nothing offered to create another, adopt a repo or bring in another team's work. Those commands were only in the Command Palette.
- "Open it in this window?" after Create came as a notification. It slipped into the bell before it was seen.
- Clicking the first Next step of a new metarepo, **Add the repos to the manifest**, typed `atticus repos discover "<folder>"` into a terminal, placeholder and all.
- The empty Repos and Changes rows were cut-off sentences that did nothing when clicked.
- After a command ran, the sections were read again only once its notification was closed. A notification's promise settles only when it is dismissed, so a repo added from the plugin didn't show until then.
- No guide took a repo through its onboarding (clone, scan settings, scan, check the scan, spec), and none showed the setup checklist (`atticus setup`).
- `atticus absorb` wrote a proposal whose summary said to copy the files into the org pack by hand. From the plugin, that was a dead end.
- Absorb read OpenSpec, Spec Kit, prompt and agent repos and other metarepos, but not TypeSpec.
- Six "came back after a draft had fixed it" questions looked identical in the Questions section, because their first 60 characters were the same. Steps named changes by their ids.
- The command catalogue (ADR 0096) gave `scan review` the scan's own options and marked four of them required, so running it from the plugin added `--full --dry-run --warnings --json`. `scan` lost `--repos`, and `repos discover` asked for `--org` even when a folder was given.
- A scan of a repo not yet cloned said `git rev-parse failed: spawn git ENOENT`.

## Decision

1. **Start or bring in** (the + in the Next section's title bar) is always there:
   - Create a metarepo, Use Atticus in this repo and a practice metarepo.
   - With a metarepo open, also Add repos, Onboard a repo, Bring in from another repo, Accept what was brought in and Add knowledge.
2. **No metarepo, no other sections.** Questions, Repos, Changes, Knowledge and Catalog show only when a metarepo is open, so the welcome has the room. The sections get starting sizes, with Next the largest.
3. **A made metarepo opens.**
   - In an empty window it opens at once.
   - Otherwise a dialog asks: Open it here, or Open in a new window.
4. **A step with a part to fill in opens the screen that asks for it.**
   - `repos discover <folder>` opens Add repos; `change new "<title>"` opens New change; `absorb …` opens Bring in; `absorb accept <id>` opens Accept; `init` opens Create; `adopt` opens Use Atticus in this repo.
   - Any other command goes to its own pickers, with what the step gives kept (`presetFrom`). A person's step without one is still typed into a terminal.
5. **The setup checklist in Next.** `atticus setup --json` is shown as **Set up: n of m done** until the catalog is accepted. Each step not done is a click to what fixes it:
   - the machine check;
   - `orgpack validate`;
   - Add repos;
   - clone;
   - scan;
   - Add knowledge;
   - Accept the catalog, which opens the map first, then `atticus baseline`.
6. **Onboard a repo** (a repo's checklist button, or the + menu) lists its stages in order:
   1. clone;
   2. draft its scan settings with Copilot;
   3. scan;
   4. check the scan with Copilot (after every scan);
   5. draft its spec with Copilot;
   6. answer its questions;
   7. and, only if needed, teach Atticus a language it can't read (`atticus onboard`).

   Each stage shows its state, read from the local API, with its command beside it, and the next one is selected. Picking a stage runs it with what it needs given, then shows the list again, updated.

7. **Bring in from another repo** (the + menu, the Knowledge section, Add knowledge) runs `atticus absorb` from a folder or a Git URL.
   - The person gives it a name, which defaults to the folder's, and chooses how: let Atticus choose per item, copy everything it can translate, or follow theirs.
   - The dry run is shown in plain words, by kind ("3 agents, become skills"), before anything is written.
   - On a yes, the proposal is written, its SUMMARY.md opens as a page, and **Accept it** follows.
8. **`atticus absorb accept <id> [--replace] [--dry-run] [--json]`** is a new command. It copies every file an item marked adopt points at to where it belongs:
   - `org-pack/…` into the org pack, which is `.atticus/org-pack/` for a repo adopted in place;
   - `openspec/…` into the metarepo's OpenSpec folder;
   - `inputs/…` into `inputs/`.

   It also adds the `absorbed` entry to `sources.yaml`, keeping the file's comments, and checks the result with the C6 schema. A file already there with other content is kept unless `--replace`. Linked items stay references. Nothing is committed: the person opens a pull request, and merging it is the approval. The plugin shows its dry run before it runs, with Accept, or Accept and overwrite when files were changed.

9. **TypeSpec in absorb.**
   - Each `.tsp` file becomes a `typespec` item: a reference with its namespace, operations (`POST /quotes`) and models. These are read line by line, never compiled: nothing from the source is run.
   - The repo's compiled OpenAPI, if it keeps it (`tsp-output/…`), is absorbed as a schema for intake. When it isn't there, the item says to run `tsp compile .` in that repo and absorb again.
   - `tspconfig.yaml` counts with the build files. The source's format stays `plain`: the `absorbed` entry's format list is C6 and doesn't change.
10. **Plain words in the sections.**
    - A step names a change by the title in its `change.yaml` ("Place “Let members tag notes” on the flows and features").
    - A question raised again after a draft fixed it leads with what differs, and the row's description says "came back · <rule>".
    - An empty section's row is its first step, one click: "No repos yet: add them", "No changes yet: start one", "The catalog is empty: scan the repos", "No knowledge yet: add some".
11. **Nothing waits on a notification.** What a run printed is said in a notification that isn't awaited, and so is an AI step's end. The sections are read again straight away, and the onboarding list comes back straight away.
12. **The catalogue's options.**
    - An option line's description no longer counts towards the brackets that make an option optional.
    - An option given instead of an argument (`<folder> | --org <org>`) isn't required.
    - The scan's own option lines are written under `atticus scan`.
13. **A repo not cloned yet** scans as `isn't cloned here yet; run atticus workspace sync`.
14. **No contract changes.** The `typespec` item kind is absorb's own (not C1 to C6); C6's `absorbed` formats are unchanged.

## Consequences

- From an empty VS Code on Windows, the plugin alone made a metarepo, added seven Forge repos from a folder, onboarded one (clone, scan: 8 records, its 2 questions), brought in a TypeSpec repo and a repo of prompts and agents, and accepted them: 7 files copied and both sources in `sources.yaml`. Every step was checked with a screenshot.
- `nadi-meta` shows its steps with change titles, its setup at 5 of 6, and the came-back questions each leading with their own story.
- The extension is 0.2.0. Its seven checks in a real VS Code pass with 48 commands registered.
- Not built here:
  - The IntelliJ plugin has no Start menu, setup checklist, onboarding list or Bring in. Its Run a Command offers `absorb accept` like every other command.
  - Absorb from a Git URL was checked only by the existing tests, not in VS Code.
  - The dialogs were checked in VS Code's in-window style. A person's VS Code on Windows shows them as native dialogs; they hold the same text and buttons.

## Addendum (2026-10-26): what is packaged for Copilot

ADR 0121's addendum of the same date adds `plugins/copilot/`, the committed, generated artifact of
Atticus's steps as GitHub Copilot custom agents and instructions, beside `plugins/atticus` for
Claude Code (ADR 0104). It is not installed the way the Claude Code plugin is: Copilot has no
marketplace for agents, so a person copies `.github/agents/`, `.github/instructions/` and
`.vscode/mcp.json` into the metarepo, in a pull request like any other change to it, and runs
`atticus assistant-files` there for the prompt files and the organisation's own agents and skills.
`docs/guide/copilot-agent-mode.md` is the guided path, and the checklist in it is what a person
confirms in a real Copilot session.
