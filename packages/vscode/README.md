# Atticus for VS Code

Run Atticus's AI steps with GitHub Copilot's own model, without pasting prompts. The extension runs a step's whole loop: Atticus prepares the prompt, Copilot's model answers, Atticus checks the answer and hands it back when it is wrong, and the model drafts again. It stops only when the step is done, when a question needs a person, or when something stops it, and it says why.

Atticus's command line does all the checking. The extension only carries the prompt to the model and the answer back (ADR 0090).

## What you need

- VS Code 1.95 or later, with GitHub Copilot set up and signed in (built into VS Code 1.143 and later; the GitHub Copilot Chat extension before). **Atticus: Set up GitHub Copilot** opens VS Code's own setup.
- The `atticus` command line on your PATH (or its path in the setting `atticus.path`), Node 22.13 or later.
- Your metarepo open in VS Code: the folder with `org-pack/` (or `.atticus/org-pack/`). With none open, the sidebar offers to make or open one.

## Install

Install it from the Marketplace once it is published there (search for Atticus, publisher maycombhq; how to publish is in [PUBLISHING.md](https://github.com/maycombhq/atticus/blob/main/packages/vscode/PUBLISHING.md)), or from the `.vsix` file:

1. In VS Code, open the Extensions view, click `...` at the top, and pick **Install from VSIX...**.
2. Choose `atticus-<version>.vsix`.

Or in a terminal: `code --install-extension atticus-<version>.vsix`.

To build the file from the source: build the app (`pnpm --filter @maycombhq/ui build`), then `pnpm --filter atticus package`. It copies the app into `media/app` and writes `packages/vscode/atticus-<version>.vsix`.

## New to Atticus?

Open **Get started with Atticus** (Help → Welcome, or the link in the Atticus sidebar). It takes you from installing the command line to your first change, with a button at each step. With no metarepo open, the sidebar offers to open one, create one, use Atticus in the repo you have open, or make a practice one with invented repos.

**Start or bring in:** the + in the Next section's title bar, always there. Create a metarepo, use Atticus in the repo you have open, or make a practice one. With a metarepo open, also:

- **Add repos.**
- **Onboard a repo:** its stages in order, each with its state.
  1. Clone.
  2. Its scan settings, with Copilot.
  3. Scan.
  4. Check the scan, with Copilot.
  5. Its spec, with Copilot.
  6. Its questions.

  Pick one to run it, and the list comes back updated.

- **Bring in from another repo:** another metarepo, an OpenSpec, Spec Kit or TypeSpec repo, or a repo of prompts, agents, skills and checklists, from a folder or a Git URL. You see what it found in plain words before anything is written. Then its summary opens as a proposal, and **Accept** copies what it adopts into the org pack and adds it to `sources.yaml`. Nothing is committed: open a pull request with it.
- **Add knowledge:** a wiki, files, or reading the sources.

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
| `@atticus /small <change>`        | A small change, brief to tasks in one step (`atticus change small`, ADR 0113)            |
| `@atticus /answer`                | Each open question with its options as buttons; a click runs `atticus questions answer`  |
| `@atticus /diagram [repo] [flow]` | The repo on the Architecture canvas, or one of its flows, in the Atticus tab             |
| `@atticus /new <title>`           | Start a change: pick its type, then write its brief                                      |
| `@atticus /run <command>`         | Any atticus command, with its dry run and your approval for a shared write               |
| `@atticus /ask <question>`        | A plain question to the catalog (`atticus ask`); no model is used                        |

Without a repo or change, a step command takes the one `atticus next` names for that step.

When a step ends, its reply has **Open the prompt** and **Open the answer** (ADR 0106): what Atticus asked the model in the last round, and what the model answered, each when its file is there.

**The prompt history** (ADR 0110): every `@atticus` request and the reply it streamed are recorded through `atticus history add`, in `.atticus/history/` on your machine (never committed). A chat's requests share a session while the chat goes on; a new chat starts another. **Atticus: Open the prompt history** opens the app's Prompt history screen in the Atticus tab. Only `@atticus` is recorded: VS Code gives extensions no access to Copilot's other chats, so what you ask Copilot directly isn't. `atticus history off` stops recording on your machine; the org pack can turn it off for everyone (`history: { record: false }` in `runtime.yaml`).

## The sidebar

## Small changes, files and tasks (ADR 0113)

- **A small change** (its change type is small, or its brief says `Size: small` where the type allows it) has one step before its tasks: **Run a small change's fast path** in the palette, `@atticus /small <change>`, or Next's **Run it**. Copilot places it, writes its target flows and words its stories in one answer; Atticus checks it as the three stages would.
- **Attach to Atticus change**: right-click one or more files in the Explorer, or a change in the sidebar, or use the palette. You pick the change; `atticus change attach` copies the files into its `inputs/`, and its steps read them as data, citing each by line or page.
- **Start this task in Copilot**: on a task in the Changes section (or the palette). It reads `atticus task context` and opens Copilot Chat in agent mode with `/atticus-task <change> <task>` (or, before `atticus assistant-files` has written that prompt file, the task's context itself), left in the box for you to send. Agent mode needs VS Code 1.99 or later; an older one opens the chat in its usual mode. If the chat can't be opened, the context is put on the clipboard and the notification says so.

## Everything Atticus does

**Atticus: Run a command…** (the Command Palette, the terminal button in the Next section, or `@atticus /run` in Copilot Chat) offers every command the command line has, by area: set up, repos and specs, knowledge, the catalog, changes, plans, release (ADR 0096). The list comes from `atticus commands --json`, so a new command is there as soon as your `atticus` has it.

- Each argument is asked with a picker: a repo, a change, an open question, a finding, a flow, a system, a file, or the values a choice takes. Then the options it needs (a change's type, from `org-pack/change-types.yaml`), then any options to add.
- AI steps run with Copilot's model. A command that writes to a shared system (a hand-off pull request, ADO work items, service-desk requests, a task run, a digest sent) runs as a dry run first. The extension shows what the dry run says and asks you before it adds `--approve` or `--send`. A server opens a terminal. Everything else runs, and what it printed is in the Atticus output (or, from the chat, in the chat).
- In the chat, type the command after `/run` (`@atticus /run spec check nadiengine`). What's missing is filled in from the pickers.

**Starting a change:** the + button in the Changes section, **Atticus: New change**, or `@atticus /new <what it is>`. Pick its type, and the brief opens. Write it, save it, then run the feature stage from the message or with `@atticus /feature <change>`.

**On a repo or a change:** its play button lists every command that takes it, with it filled in: for a repo, survey, verify, spec draft and check, repo type and the rest; for a change, the stages, the critic, status, hand-off, tasks, service desk, work items, release and the rest.

**When the window opens**, the extension checks whether the metarepo needs `atticus upgrade` and whether this machine is ready (`atticus doctor`), and says so with a button when something needs a look.

The Atticus icon in the activity bar opens a sidebar with a section for each part of Atticus (ADR 0093, 0096), in the order of a working day (ADR 0105): what is next, what waits on you, your changes, what the organisation knows, then the estate.

- **Next**: the next step in plain words, then the steps after it. Click any of them, or its Run button, to take it; its command is in the tooltip. A step with a part to fill in opens the screen that asks for it. **Raise a change's open needs** lists them to mark one by one. Then **Set up** (the setup checklist until the catalog is accepted; click a step to do it, or the checklist to do the next one) and **Open the app**.
- **Waiting on you** (ADR 0105; was Questions): what waits on you across every change. An empty group is left out; when nothing waits, one row says so.
  - **By change** (the default): each change with something open, its title, id and count, and under it its open needs, then its open findings, then its manual steps. Changes with a blocking finding come first, then the rest by title. Last, **Not part of a change**: the questions by repo, manual steps with no change, and knowledge to verify.
  - **By kind**: a group for each kind with its count, as below. The title bar's **Group by kind** and **Group by change** switch between the two; the choice is remembered for the workspace.
  - **Questions**: the open questions by repo. Click one to answer it: pick an option or write your own words. A repo's button answers its questions one after another.
  - **Needs**: every change's open needs, each naming its change. Click one to open `needs.md` at it; its **Done…** and **Not needed…** buttons are those of a change's needs.
  - **Manual steps**: the steps a person does in systems Atticus can't reach (`atticus todo`), each with its change and system, and what it waits for. Click one to read it (`atticus todo show`) in a tab, with **Record it…**.
  - **Findings**: the critic's open findings on every open change, blocking first. Click one to open its change in the app; its check button acts on it, as in Changes.
  - **Knowledge to verify**: how many knowledge items no person has verified. Click it to check them one after another.
- **Changes**: each change with its state and blocking findings. Under it, each of its files with its state, its tasks (each with Run the task) (click to open; one not written yet says so), its target flows (each flow the change adds, changes or removes; click to see it beside today's, with each step marked Added, Changed or Removed, ADR 0095), its findings (click to open the file a finding is about; the why and the fix are in the tooltip; its check button acts on it, ADR 0094: Apply the fix, I fixed it by hand, Not relevant, Waive it or Ask someone, offering only what the critic allows, and showing a patch before applying it) and a link to the change in the app.
  - **Needs** (ADR 0101): what the change needs from the organisation, with how many are open. Before they are found, the row is **Find what it needs**: Copilot reads the change and the knowledge items, and Atticus checks each need against the change's own words. Each need shows what it is for (the change, a feature, a flow, a story or a task), its lead time and who handles it, and a green tick when a person verified the knowledge item it comes from. Its tooltip has why (quoting the change, with file and line), how to raise it, what it needs, its catalogue item and links. Click one to open `needs.md` at it. Its buttons: **Done…** (with a note, such as the request's number), **Not needed…** (say why), **Reopen**, **Open its links** and **Open the item's page**. Atticus never raises a request: you do, then mark it.
- **Knowledge** (ADR 0101):
  - **Sources**: each wiki or docs repo in `sources.yaml`, with its last snapshot and the commit it read. Its buttons: **Sync it**, **Read it with Copilot** and **Tag it…**. **Add a wiki or docs repo…** (also the + in the title bar and in Start or bring in) asks what it is (a git repo such as an Azure DevOps or GitHub wiki or a docs repo, a folder on this machine, or Confluence or SharePoint), where, its name, the folder and branch to read, whether to clone it or keep it as a submodule of the metarepo, what it is about and who owns it, then saves it into `sources.yaml` and offers to sync and read it. Confluence and SharePoint need their adapter wired to the command line, so for them it only shows the entry.
  - **Items**, by kind: requests and processes, standards and patterns, decisions and constraints, teams, vendors, products and projects. Each shows who reviewed it: a green tick when verified or corrected, "check again" when its page changed since, red when rejected. The tooltip has what it says, its how-to, links, the quote and its page. Click one to open the snapshot's copy of the page at the quote. Its buttons: **Verify**, **Correct…** (pick a field, shown with its value now; a list is edited as `a | b | c`), **Reject…** (say why), **Open its links** and **Ask about it**.
  - **What the last scan changed**: the new, changed and gone items, and the reviews to check again.
  - **Searches**: **Search the wikis…** (also in the title bar, in Start or bring in, in Add knowledge and in the Command Palette) takes a term or phrase. When no page mentions it, it says so and nothing is sent to Copilot. Otherwise Copilot reads the pages it is on, each quote is checked, and the list of what it found opens: the new ones first (picked to start with), then those already known or kept. Keep a process, a request, a standard or any other as the kind it is, or as the other kind its record can be (a request or a process, a standard or a pattern, and so on); what you keep is a knowledge item with a green tick, verified by you, and the Knowledge section opens to show it. Each saved search opens to what it found, marked new, kept or already known: click a new one, or its **Keep it…** button, to keep it; the search's **Keep…** button keeps several.

  Its title bar has four buttons: **Add a wiki or docs repo…**, **Search the wikis…**, **Scan the knowledge sources** (read them all with Copilot) and **Sync the knowledge sources**. Its menu (…) has the rest in three groups: reading (**Ask the knowledge**, **Keep what a search of the wikis found…**), reviewing (**Check what no one has verified…**) and the org pack (**Draft the org pack from the wikis…**). Reviews, sources and needs are files in the metarepo: commit them through a pull request.

- **Repos**: each repo with its last scan, and its checklist button: **Onboard a repo**. The + button adds repos from a folder of clones or a Git host organisation: it shows what it found and adds them when you say yes. Under it, its flows, then each flow's steps. Click a step to open the code at the line it cites, or use its diagram button to see it in the flow. Click a flow to open its diagram. The repo's scan settings and its place on the canvas are there too. Its menu (…) also has **Onboard a repo…**, **Clone or update the base clones** and **Bring in from another repo…** (moved from Knowledge, ADR 0105).
- **Catalog**: each kind of record with its count. Under it, its records (click to open the record's YAML), and under each record, the code it was read from.
- **Model runs** (ADR 0106), collapsed at the bottom: what Atticus asked a model and what came back, from `atticus runs --json`, newest first. Each run shows its step or change, the agent, its round, its state, whether it was answered and how many problems the checks handed back to it. Open one for **Open the prompt**, **Open the answer** (when there is one; an answer kept only in the run's record opens read-only, from `atticus runs show`) and **Open in the app** (the app's Model runs screen on that run, with the prompt, the answer and the problems round by round). It reads again when a step ends.

**Filter…** (ADR 0105), in the title bars of Waiting on you, Changes, Knowledge and Model runs, asks for words to match, for example `forge-ledger`. Each row is matched, case-insensitively, against its title, id, change and repo (and the words beside it); every word must match. A row that matches keeps everything under it, and a row shows when something under it matches: in Knowledge that looks inside sources, items, what the last scan changed and searches; in Changes a change shows when it matches itself (its title, id or repos); in Model runs a run matches its step or change, run id, agent and state. The view's description says `filter: <words>`, and **Clear filter** removes it. When nothing matches, one row says what was filtered; click it to clear the filter. Each view keeps its own filter until the window closes.

The sections read the app's local API on 127.0.0.1, which the extension starts for them; they follow the files as they change, and the Refresh button reads everything again. Each section, and each part of one you open, shows a "Reading…" row until it is read; when it is read again, what it showed stays, with the section's progress bar, until the new rows are in. A part that can't be read says why: click the row to see the Atticus output.

**What a click shows.** Every command the extension runs says what it is doing in plain words while it runs ("Copying forge-wiki's pages (a snapshot)…", "Searching the wikis for “Kafka topic”: Copilot reads the pages that mention it…"), with the command underneath. A pick list that has to read its items (repos, changes, questions, needs, searches, the onboarding stages) opens at once and shows "Reading…" while it reads. What finds nothing says so, and what fails says why, with a button to the Atticus output. When the only way on is a button (Run it, Add repos, Add a wiki), it is a dialog, not a notification that slips into the bell.

**In the code.** Above each line a spec flow cites, a line says which flow and step cite it, and whether a check confirmed it: `Atticus: Save a chart · step 4, lookup · confirmed by the check`. Click it to open the flow beside the code with that step marked. A line a catalog record was read from says which records (`Atticus: Endpoint nadiengine-api.post-horoscope`); click it to open the record's YAML. One local call per file gives both (ADR 0094). This works for a repo whose code is on this machine: a folder in the window named for the repo, or its base clone in `workspace/<repo>`. Turn them off with the setting `atticus.codeLens`, or only the records' with `atticus.codeLens.records`.

**The status bar** shows the open questions and the next step; click it to open the sidebar.

**Open the app** shows the Atticus app, with its diagrams, in a VS Code tab. The app comes from the extension's own files (ADR 0097): it isn't a page on 127.0.0.1 framed in the tab, so it works where framing a local page is blocked, and over SSH or in a container. Its calls go through the extension to the local API, which the extension starts for the tab and the sidebar (`atticus ui`) and stops when the window closes. **Run with Copilot** on an AI step in the app (ADR 0106) asks the extension, which runs only the command line's AI steps, refuses any argument that starts with `-`, and runs the step as the sidebar does: Copilot, your consent and every check. Its progress shows in the app and in a notification, and its ending as any step's does. The setting `atticus.appIn` set to `frame` uses the framed page instead (ADR 0091). **Atticus: Open the app in the browser** opens it in a browser.

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
- **To the `atticus` command line, on this machine:** the commands in the output. They read and write files in the metarepo, as they do in a terminal. Each `@atticus` request and its reply go to `atticus history add` on its stdin (ADR 0110), kept in `.atticus/history/` on this machine.
- **To the app it started, on `127.0.0.1`:** the sidebar's and the CodeLens's reads of the local API, with the session token the app printed. The one write is a finding's action, when you pick it.
- **To the app in its tab:** a step's progress and how it ended, when you ran it from the app with **Run with Copilot**.
- **Nowhere else.** No telemetry. The extension makes no other network call.

A prompt longer than the model takes is never cut: the extension says so and stops, and the run waits, so you can finish it another way. Cancel stops the step; nothing more is sent or written.

## What it doesn't do

- It doesn't check anything itself. Every check is Atticus's.
- It runs `/atticus-onboard`, `/atticus-knowledge`, `/atticus-task` and `/atticus-release` steps only when `atticus next` names them (Run in the view or the chat): there is no chat command for them yet.
- The sidebar never runs a step. The only file it changes is a finding's record (and, for Apply the fix, the patched file), when you act on the finding. Steps run from Next, the chat or the Command Palette.
- Its checks run inside a real VS Code (`pnpm --filter atticus test:vscode`), and its flows were driven there from an empty window to an onboarded repo and an accepted absorb (ADR 0100). Its AI steps have been run with a fake model, not yet with Copilot's on a bank machine.
