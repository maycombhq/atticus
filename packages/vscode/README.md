# Atticus for VS Code

Run Atticus's AI steps with GitHub Copilot's own model, without pasting prompts. The extension runs a step's whole loop: Atticus prepares the prompt, Copilot's model answers, Atticus checks the answer and hands it back when it is wrong, and the model drafts again. It stops only when the step is done, when a question needs a person, or when something stops it, and it says why.

Atticus's command line does all the checking. The extension only carries the prompt to the model and the answer back (ADR 0090).

## What you need

- VS Code 1.95 or later, with the GitHub Copilot Chat extension, signed in.
- The `atticus` command line on your PATH (or its path in the setting `atticus.path`), Node 22.13 or later.
- Your metarepo open in VS Code: the folder with `org-pack/` (or `.atticus/org-pack/`). The extension starts when that folder is open.

## Install

Install it from the Marketplace once it is published there (search for Atticus, publisher maycombhq; how to publish is in [PUBLISHING.md](https://github.com/maycombhq/atticus/blob/main/packages/vscode/PUBLISHING.md)), or from the `.vsix` file:

1. In VS Code, open the Extensions view, click `...` at the top, and pick **Install from VSIX...**.
2. Choose `atticus-<version>.vsix`.

Or in a terminal: `code --install-extension atticus-<version>.vsix`.

To build the file from the source: build the app (`pnpm --filter @maycombhq/ui build`), then `pnpm --filter atticus package`. It copies the app into `media/app` and writes `packages/vscode/atticus-<version>.vsix`.

## New to Atticus?

Open **Get started with Atticus** (Help → Welcome, or the link in the Atticus sidebar). It takes you from installing the command line to your first change, with a button at each step. With no metarepo open, the sidebar offers to open one, create one, use Atticus in the repo you have open, or make a practice one with invented repos.

**Shortcut keys:** Ctrl+Alt+Shift+A runs any command, Ctrl+Alt+Shift+N the next step, and Ctrl+Alt+Shift+D opens the app (Cmd on macOS).

## Try it

1. Open the metarepo folder.
2. Open Copilot Chat and type `@atticus /next`. It shows the next step and a button to run it.
3. Click the button (or type, for example, `@atticus /survey forge-notes`). The first time, VS Code asks whether Atticus may use the Copilot model: allow it.
4. Watch the step run in the chat. When it stops at a question, click an answer, then run the step again.

## In Copilot Chat

| Command                           | What it does                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `@atticus /next`                  | The next step, from `atticus next`, with a button to run it                              |
| `@atticus /survey <repo>`         | Draft the repo's scan settings (`atticus scan survey`)                                   |
| `@atticus /verify <repo>`         | Compare the repo's code with its last scan (`atticus scan verify`)                       |
| `@atticus /spec <repo>`           | Draft the repo's spec, then `atticus spec check`; draft again on findings, up to 3 times |
| `@atticus /feature <change>`      | The change's feature stage (`atticus change feature`)                                    |
| `@atticus /architecture <change>` | The change's architecture stage (`atticus change architecture`)                          |
| `@atticus /stories <change>`      | The change's stories and tasks (`atticus plan stories`)                                  |
| `@atticus /answer`                | Each open question with its options as buttons; a click runs `atticus questions answer`  |
| `@atticus /diagram [repo] [flow]` | The repo on the Architecture canvas, or one of its flows, in the Atticus tab             |
| `@atticus /new <title>`           | Start a change: pick its type, then write its brief                                      |
| `@atticus /run <command>`         | Any atticus command, with its dry run and your approval for a shared write               |
| `@atticus /ask <question>`        | A plain question to the catalog (`atticus ask`); no model is used                        |

Without a repo or change, a step command takes the one `atticus next` names for that step.

## The sidebar

## Everything Atticus does

**Atticus: Run a command…** (the Command Palette, the terminal button in the Next section, or `@atticus /run` in Copilot Chat) offers every command the command line has, by area: set up, repos and specs, knowledge, the catalog, changes, plans, release (ADR 0096). The list comes from `atticus commands --json`, so a new command is there as soon as your `atticus` has it.

- Each argument is asked with a picker: a repo, a change, an open question, a finding, a flow, a system, a file, or the values a choice takes. Then the options it needs (a change's type, from `org-pack/change-types.yaml`), then any options to add.
- AI steps run with Copilot's model. A command that writes to a shared system (a hand-off pull request, ADO work items, service-desk requests, a task run, a digest sent) runs as a dry run first. The extension shows what the dry run says and asks you before it adds `--approve` or `--send`. A server opens a terminal. Everything else runs, and what it printed is in the Atticus output (or, from the chat, in the chat).
- In the chat, type the command after `/run` (`@atticus /run spec check nadiengine`). What's missing is filled in from the pickers.

**Starting a change:** the + button in the Changes section, **Atticus: New change**, or `@atticus /new <what it is>`. Pick its type, and the brief opens. Write it, save it, then run the feature stage from the message or with `@atticus /feature <change>`.

**On a repo or a change:** its play button lists every command that takes it, with it filled in: for a repo, survey, verify, spec draft and check, repo type and the rest; for a change, the stages, the critic, status, hand-off, tasks, service desk, work items, release and the rest.

**When the window opens**, the extension checks whether the metarepo needs `atticus upgrade` and whether this machine is ready (`atticus doctor`), and says so with a button when something needs a look.

The Atticus icon in the activity bar opens a sidebar with a section for each part of Atticus (ADR 0093, 0096):

- **Next**: the next step in plain words (click it or its Run button; its command is in the tooltip), the steps after it, and **Open the app**.
- **Questions**: the open questions by repo. Click one to answer it: pick an option or write your own words. A repo's button answers its questions one after another.
- **Repos**: each repo with its last scan. The + button adds repos from a folder of clones or a Git host organisation: it shows what it found and adds them when you say yes. Under it, its flows, then each flow's steps. Click a step to open the code at the line it cites, or use its diagram button to see it in the flow. Click a flow to open its diagram. The repo's scan settings and its place on the canvas are there too.
- **Changes**: each change with its state and blocking findings. Under it, each of its files with its state, its tasks (each with Run the task) (click to open; one not written yet says so), its target flows (each flow the change adds, changes or removes; click to see it beside today's, with each step marked Added, Changed or Removed, ADR 0095), its findings (click to open the file a finding is about; the why and the fix are in the tooltip; its check button acts on it, ADR 0094: Apply the fix, I fixed it by hand, Not relevant, Waive it or Ask someone, offering only what the critic allows, and showing a patch before applying it) and a link to the change in the app.
- **Knowledge**: the sources in `sources.yaml` and the knowledge items read from them (click one to open its file). Its title bar syncs the sources, scans them and asks the knowledge.
- **Catalog**: each kind of record with its count. Under it, its records (click to open the record's YAML), and under each record, the code it was read from.

The sections read the app's local API on 127.0.0.1, which the extension starts for them; they follow the files as they change, and the Refresh button reads everything again.

**In the code.** Above each line a spec flow cites, a line says which flow and step cite it, and whether a check confirmed it: `Atticus: Save a chart · step 4, lookup · confirmed by the check`. Click it to open the flow beside the code with that step marked. A line a catalog record was read from says which records (`Atticus: Endpoint nadiengine-api.post-horoscope`); click it to open the record's YAML. One local call per file gives both (ADR 0094). This works for a repo whose code is on this machine: a folder in the window named for the repo, or its base clone in `workspace/<repo>`. Turn them off with the setting `atticus.codeLens`, or only the records' with `atticus.codeLens.records`.

**The status bar** shows the open questions and the next step; click it to open the sidebar.

**Open the app** shows the Atticus app, with its diagrams, in a VS Code tab. The app comes from the extension's own files (ADR 0097): it isn't a page on 127.0.0.1 framed in the tab, so it works where framing a local page is blocked, and over SSH or in a container. Its calls go through the extension to the local API, which the extension starts for the tab and the sidebar (`atticus ui`) and stops when the window closes. The setting `atticus.appIn` set to `frame` uses the framed page instead (ADR 0091). **Atticus: Open the app in the browser** opens it in a browser.

`@atticus /diagram <repo>` (or **Atticus: Open a repo on the Architecture canvas**) opens the tab on that repo's part of the estate. Drag boxes to rearrange them; Keep saves the arrangement in the metarepo. With no repo named it opens the whole estate. `@atticus /diagram <repo> <flow id>` opens one of the repo's flows as a sequence of steps (ADR 0092), and `@atticus /diagram <repo> <words>` lists the flows that match.

The same actions are in the Command Palette under **Atticus:**. Every `atticus` command the extension runs, with its exit code, is in the **Atticus** output.

## Settings

| Setting                    | Default   | What it is                                                                                                                                                                                                                            |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atticus.path`             | `atticus` | The `atticus` command: a command on PATH, its full path, or the path to its `bin.js` (run with `node`). On Windows the extension reads the `atticus.cmd` that npm or pnpm writes and runs the `bin.js` it names, so no shell is used. |
| `atticus.model`            | empty     | A Copilot model family, for example `gpt-4o`. Empty: the model picked in Copilot Chat, else the first Copilot model.                                                                                                                  |
| `atticus.codeLens`         | on        | Above each line of code a spec flow cites, show which flow and step cite it.                                                                                                                                                          |
| `atticus.codeLens.records` | on        | With `atticus.codeLens` on, also show which catalog records were read from a line.                                                                                                                                                    |
| `atticus.appIn`            | `panel`   | `panel`: the app from the extension's own files. `frame`: the page `atticus ui` serves, framed.                                                                                                                                       |

## What is sent where

- **To the Copilot model, through VS Code's Language Model API (`vscode.lm`):** a step's prompt file as Atticus wrote it, after one line from the extension that asks for only the result file's content. The prompt holds what the step read from your metarepo and repos. Nothing else is sent to the model, and nothing goes to the model without your consent (VS Code asks the first time).
- **To the `atticus` command line, on this machine:** the commands in the output. They read and write files in the metarepo, as they do in a terminal.
- **To the app it started, on `127.0.0.1`:** the sidebar's and the CodeLens's reads of the local API, with the session token the app printed. The one write is a finding's action, when you pick it.
- **Nowhere else.** No telemetry. The extension makes no other network call.

A prompt longer than the model takes is never cut: the extension says so and stops, and the run waits, so you can finish it another way. Cancel stops the step; nothing more is sent or written.

## What it doesn't do

- It doesn't check anything itself. Every check is Atticus's.
- It runs `/atticus-onboard`, `/atticus-knowledge`, `/atticus-task` and `/atticus-release` steps only when `atticus next` names them (Run in the view or the chat): there is no chat command for them yet.
- The sidebar never runs a step. The only file it changes is a finding's record (and, for Apply the fix, the patched file), when you act on the finding. Steps run from Next, the chat or the Command Palette.
- It has only been tested with a fake model, the real command line and the real API, and in Chromium set up like a VS Code panel, not inside VS Code itself.
