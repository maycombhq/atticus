# Changelog

The Atticus extension for VS Code. The command line's own changes are in the repository's [CHANGELOG](https://github.com/maycombhq/atticus/blob/main/CHANGELOG.md).

## 0.7.1 (pre-release, with Atticus 2.0.0-beta.3)

- **Ships with Atticus 2.0.0-beta.3.** No change to the extension itself; the command line adds `atticus workspace sync --from <folder>`, which copies base clones from the clones already on the machine instead of cloning again.

## 0.7.0 (pre-release, with Atticus 2.0.0-beta.2)

- **A new version for this release.** 0.6.0 was also what a development build said, so VS Code couldn't tell the two apart.
- **The session token stays out of the Atticus output.** The extension makes the app's token and gives it to `atticus ui --embed vscode` in its environment; the app no longer prints it there, and any token a line carries is written as "(hidden)". The output is kept in VS Code's log folder, the log people attach to a support ticket. With an older command line the token it prints is hidden too.
- **Each line of the Atticus output starts with the time** (to the millisecond), so a log says how long the app took to start.
- **Check this machine no longer warns that port 4321 is in use** when `atticus ui` runs there: the extension starts its own app on a free port.
- **Every view and command, by default** (the product owner: "I see only 3 tabs... knowledge, model calls etc. are gone"). The sidebar opens on Next and Waiting, Questions and Changes, with **Knowledge**, **Repos**, **Catalog** and **Model runs** collapsed below them. The Command Palette and `@atticus` offer every command (Open the prompt history, Ask the catalog, the diagrams, the estimate, the knowledge commands, Run a command… and its key, `/new`, `/ask`, `/run` and the rest), as do a repo's and a change's play buttons, Run the task and Start or bring in.
- **`atticus.fullUi` now offers only Atticus 1's legacy commands** (Survey a repo, Verify a repo's last scan, Draft and check a repo's spec, Run a small change's fast path, Scan every repo, Accept the catalog, and `@atticus` /survey, /scanverify, /spec, /small), and starts the app with `atticus ui --full`.
- **The app in the tab has More pages and Ctrl+K for every page**, as in the browser; Model runs is a tab of Set up. A click on the menu's "Ctrl+K: any page" opens it, for when VS Code keeps the keys.

## 0.6.0 (pre-release, with Atticus 2.0.0-beta.1)

- **The twelve commands first** (ADR 0124 addendum D-cli): Run a command…, a repo's and a change's commands and `@atticus /run` list the command line's twelve (those `atticus commands --json` marks `legacy: false`) first, in `atticus help`'s order, then every other command by area under **Legacy**. With an older command line they are listed by area as before.
- **The walkthrough maps first:** map a repo, verify it and see the Map, then start a change; scanning and drafting specs are the last two steps, under **Legacy**.

### Run in a real VS Code (VS Code 1.143.1, Linux, 2026-10-25)

The 0.5.0 arrangement had only been compiled. It was run in a real VS Code, from the source folder and installed from the `.vsix`, on a practice metarepo with an assistant's facts for forge-ledger, and in a window with no folder.

- **Fixed: a repo opened "on the canvas" landed on a change's Architecture tab.** Since the app's six entries, `#/architecture` is Change › Architecture, which shows a change's next step ("Run next: atticus scan") above the diagram. Open a repo on the Architecture canvas, a repo's **On the canvas** row and `@atticus /diagram <repo>` now open the Map's estate canvas (`#/canvas?node=repo:<repo>`).
- **What was run and passed:** the extension starts by itself in both windows; the three views open and read the metarepo; all fifteen palette commands run without an error (the AI steps stop on the dialog that says to set Copilot up, as they should with no model; with no folder each says to open or create a metarepo); **Verify a repo's facts** picks the repo in Atticus's list, then how in VS Code's own, and `atticus verify` ends 0 in its terminal; the app opens on Home, its scripts run under the panel's policy, it reads the local API through the extension (26 calls), the canvas lays forge-ledger out, and Chromium's console logs nothing the policy or a missing file stopped; a cited line has its CodeLens; the status bar names the next step; `@atticus` `/next`, `/answer` and `/verify` answer, and `/map` says no model is available. From the `.vsix`: it installs, starts from the extensions folder with `dist/`, `media/app/` and its icons, and passes the same checks.
- **`pnpm --filter atticus test:vscode`** downloads VS Code stable with `@vscode/test-electron` (into the repo's `.cache/vscode-test`) when none is installed, runs on Linux as root (`--no-sandbox`) under `xvfb-run`, and runs the suite twice: on the metarepo and with no folder. `test:vscode:packaged` runs it on the extension installed from the newest `.vsix`. `test-vscode/person.ts` does what a person does (`Person` answers the dialogs, picks in the real lists, follows the terminals); `ATTICUS_VSCODE_TEST_SHOTS=<dir>` saves screenshots. Results are written as each check ends, so a window that dies still says what passed.
- **Left for a person with Copilot:** the AI steps with Copilot's model (`/map`, `/feature`, `/architecture`, `/stories`, `/critic`, Run it); that VS Code hides `@atticus`'s other commands until `atticus.fullUi` is on; `/task` opening agent mode; and Pick the model listing Copilot's models. The test VS Code has no Copilot sign-in, so these were run only as far as "no model".

## 0.5.0 (pre-release, with Atticus 2.0.0-rc.1)

Three views and the steps; the rest behind `atticus.fullUi` (Phase D, ADR 0124 addendum D-app).

- **Three views:** **Next and Waiting** (the next step, the steps after it, then **Waiting on you** open under them: needs, findings, manual steps and knowledge to verify, by change or by kind, with its filter), **Questions** (the open questions by repo, each answered in the dialog with the lines it read; its tooltip shows them too) and **Changes**.
- **About fifteen commands in the Command Palette:** the next step and Run it, the steps (read a repo with map, verify, feature, architecture, stories, the critic), answer a question, open the app, the output, a new change, start a task in Copilot, check this machine, pick the model.
- **`@atticus` runs the steps:** `/next`, `/map <repo>` (new: the batched read of ADR 0124, a batch a round, up to 50), `/verify`, `/feature`, `/architecture`, `/stories`, `/task <change> [task]` (new: the task in agent mode with its context), `/critic <change>` (new), `/answer`.
- **The app opens on Home**, the first of its six entries.
- **The setting `atticus.fullUi`** (off) offers everything else again, as `atticus ui --full` does for the app: the Knowledge, Repos, Catalog and Model runs views, **Run a command…** (in the palette, the title bar and Ctrl+Alt+Shift+A), a repo's and a change's play button, **Run the task**, the rest of the palette, `@atticus`'s other commands (`/run`, `/ask`, `/new`, `/survey`, `/spec`, `/small`, `/diagram`, `/changemap`, `/estimate`), bringing in from Start or bring in, and the app with every page. Nothing was removed; changing the setting starts the app again.
- Not yet run in a real VS Code: the suite in `test-vscode` has new checks for the three views and Home, compiled but not run here.

- **Every step's prompt fits the model** (ADR 0112): the extension tells every AI step its Copilot model's limit, not only the knowledge scan, so each builds a prompt that fits (8,658 of GPT-4o mini's 12,078 tokens, by the command line's count) instead of ending "the prompt is too long". A step that can't fit even its smallest useful prompt says so before anything is sent, with the numbers and what to do.

Small changes fast, files into a change, and a task started with its context (ADR 0113).

- **Start this task in Copilot** on a task (and in the palette): Copilot Chat opens in agent mode with `/atticus-task <change> <task>`, or the task's context itself where the prompt file isn't written yet, for you to send; the context goes on the clipboard when the chat can't open.
- **Attach to Atticus change** in the Explorer's context menu (every file selected), on a change in the sidebar and in the palette.
- **Run a small change's fast path** in the palette and `@atticus /small <change>`; Next's **Run it** runs it with Copilot.

## 0.3.1

Nothing a person clicks leaves them unsure.

- **Copilot's model can look things up** (ADR 0107 addendum): when a step offers its read-only tools, the extension passes them through the language model API's tool calls; Copilot's model may search what Atticus knows, show a record, walk its links or show the code a fact cites. Each call runs as `atticus context call` with the run's id, so Model runs shows what the model looked at; at most 6 rounds, and never more than the model's own room. A model without tool calls gets the prompt as before.
- **A big wiki is read in batches.** Reading the knowledge sources with a model that takes less than the pages (Copilot's GPT-4o mini takes 12,078 tokens) no longer stops at "the prompt is too long": the pages are read in batches that fit, one after another, with "N pages left to read: batch 2" as it goes.
- **The sidebar in the order of a working day** (ADR 0105): Next, Waiting on you, Changes, Knowledge, Repos, Catalog. Changes moves up from fourth.
- **Waiting on you** (was Questions; the view id `atticus.questions` stays, so settings and keybindings that name it keep working): what waits on you across every change, a group for each kind with its count. **Questions** by repo, as before; **Needs** still open on any change, each naming its change and opening `needs.md` at it, with **Done…** and **Not needed…**; **Manual steps** to do, each opening what `atticus todo show` says, with **Record it…**; **Findings** open on any open change, blocking first, each opening its change, with its check button; and **Knowledge to verify**, how many items no one has verified, opening **Check what no one has verified**. An empty group is left out, and when nothing waits one row says so. It shows "Reading…" until read, says why a part couldn't be read, and refreshes with the other sections.
- **Knowledge's title bar** keeps four buttons (Add a wiki, Search the wikis, Scan the knowledge sources, Sync the knowledge sources); the rest are in its menu in three groups: reading (Ask the knowledge, Keep what a search found), reviewing (Check what no one has verified) and the org pack (Draft the org pack from the wikis).
- **Bring in from another repo…** moves from the Knowledge menu to the Repos menu.
- **Waiting on you, by change** (ADR 0105 addendum), the default: each change with something open, with its title, id and count, and under it its open needs, open findings and manual steps, in that order; changes with a blocking finding first, then by title. Then **Not part of a change**: the questions by repo, manual steps with no change, and knowledge to verify. Each row keeps its buttons. **Group by kind** in the title bar switches to the layout by kind, and **Group by change** back; the choice is remembered for the workspace.
- **Model runs** (ADR 0106): a section collapsed at the bottom of the sidebar lists what Atticus asked a model and what came back (`atticus runs --json`), newest first: each run's step or change, agent, round, state, whether it was answered and how many problems were handed back. A run opens to **Open the prompt**, **Open the answer** and **Open in the app** (the app's Model runs screen on that run). It has its own **Filter…**, shows "Reading…" until read, says why when it can't be read, and reads again when a step ends.
- **The prompt history** (ADR 0110): every `@atticus` request and the reply it streamed are recorded through `atticus history add` (the text on its stdin), in `.atticus/history/` on your machine, one session per chat. **Atticus: Open the prompt history** opens the app's Prompt history screen in the Atticus tab. Copilot's other chats aren't recorded: VS Code gives extensions no access to them.
- **Open the prompt** and **Open the answer** (ADR 0106) on a step's ending, in its notification and its `@atticus` reply: the last round's prompt and the model's answer, each when its file is there.
- **Run with Copilot from the app** (ADR 0106): the app in its VS Code tab asks the extension to run an AI step (the bridge message `run-step`); the extension runs only the command line's AI steps, refuses any argument that starts with `-`, runs it as the sidebar does (Copilot, your consent, the checks), and sends its progress and its ending back to the app.
- **Filter…** in the title bars of Waiting on you, Changes and Knowledge: words to match (for example forge-ledger), case-insensitively, against each row's title, id, change and repo; every word must match. A row that matches keeps what is under it, and a row shows when something under it matches. The view's description says `filter: <words>`, and **Clear filter** removes it. When nothing matches, one row says what was filtered; click it to clear the filter. Each view keeps its own filter until the window closes.

- **Progress in plain words.** Every run says what it is doing ("Recording that request-kafka-topic is right…", "Finding what add-note-tags needs from the organisation, with Copilot…"), with the command underneath, instead of the command alone. Checking this machine, reading the next step, drafting the org pack, asking the catalog, acting on a finding, answering a question and finding a need's page now show progress too; before, some showed nothing until they ended.
- **Pick lists open at once.** Lists that read their items (a command's repo, change, question, finding, flow or system; Run a command; the onboarding stages; the open needs; the searches; what no one has verified) open straight away with "Reading…" and VS Code's busy bar, instead of appearing late.
- **Reading rows in every section.** Repos, Changes, Knowledge and Catalog, and every part of them (items by kind, needs, searches, what changed, flows, tasks), show "Reading…" until read; a refresh keeps the rows on show, with the section's progress bar, until the new ones are read. A part that can't be read says "Couldn't read this: why" and opens the Atticus output when clicked. An empty part says what fills it ("No tasks yet: the stories stage writes them").
- **Searching the wikis, start to end.** Says when no page mentions the phrase (nothing is sent to Copilot), and when there is no wiki to search yet (a dialog to add one). What it found opens as a list, new first and picked, then those already known or kept. Each item is kept as its own kind or the other its record can be, described in plain words (a request offers request or process, no longer every kind, which the command line refused). The Knowledge section then opens, with the kept items ticked. A saved search now opens in the Knowledge section to what it found, each marked new, kept or already known; a new one is kept with a click or its **Keep it…** button, and the search's **Keep…** button keeps several.
- **Add knowledge** and **Start or bring in** also offer: Keep what a search found, Check what no one has verified, and Draft the org pack from the wikis.
- **Check what no one has verified** opens each item's page beside the list.
- **Ask about it** (a knowledge item) runs with Copilot like any other AI step, and shows the answer; the catalog's **Ask** says its answer too, not only in the output.
- Rows that looked clickable now act: a repo's **No flows yet: draft its spec** and **Scan settings: none yet: draft them** run those steps with Copilot.
- Picking a repo or change for Survey, Verify, Spec, Feature, Architecture and Stories is a list of the metarepo's own, not a box to type an id in.
- **Show the next step** is a dialog with Run it (or Take this step), naming the step in plain words.
- Nothing found says so: Add repos when the folder holds no repo; Answer this repo's questions when it has none; Onboard a repo when there are no repos (a dialog with Add repos); open needs, searches and unverified items when there are none; a need list that couldn't be read says why instead of "no open needs".
- A command that needs a metarepo, run without one, offers to open or create one; without the command line, it offers to check again.
- Fixed: Edit the manifest by hand failed silently when the manifest wasn't written yet; a new change whose brief couldn't be opened failed silently; the Next section could stay on "Reading the metarepo..." when reading it threw.
- A step that can't run for want of a Copilot model says so in a dialog, every time, with **Install Copilot Chat** or **Set up Copilot** and **Pick a model**; before, a second click looked dead, as VS Code doesn't show a notice again while the same one is in the bell. A prompt that is too long, or a model that didn't answer, offers **Pick a model**.
- **Copilot is set up, not installed.** With no model, Atticus offers **Set up Copilot**, VS Code's own setup (Copilot is built into VS Code 1.143 and later); it installs Copilot Chat only in an older VS Code. **Atticus: Set up GitHub Copilot** does the same.
- A step that stopped, or couldn't run, says why in its notice, in the command line's own words; all of it is behind Show details.
- **Run a command** picks what only the metarepo knows: a knowledge item, a change's need or task, a wiki source, what was brought in, a platform. Titles say what is asked ("which change?"), and an option that takes a value says so in words.
- **Run a command** also picks a feature, a manual step, a triage item, an initiative or a commitment, a glossary term, an onboarding proposal, a change's story and a catalog record (for impact); each list is titled by what it picks ("which feature?") and says why when it is empty.
- **Run a command** opens the guided screen for searching the wikis, keeping what a search found, adding a wiki, drafting or accepting the org pack, adding repos, bringing in a repo, answering a question and raising needs.
- **Ask the knowledge** shows its answer. The Catalog section has an **Ask** button.
- Escape cancels at every step of Run a command. An empty required box says what it needs, instead of ending without a word.
- Fixed: a hand-off or return asked a value for `--approve`, and `critic --resume` asked one for `--resume`. The approve flag is added only after the dry run and your yes. A dry run that failed is no longer offered for approval.
- The status bar names the next step in plain words. Without the command line it says so, and the welcome shows. Changing `atticus.path` checks again at once.
- Fixed: after Use Atticus in this repo, or making a metarepo, only the Next section showed until a reload.
- The upgrade notice names what the upgrade does. "What waits on you" shows what it read before offering to send it.
- Fixed: closing a window, or VS Code ending, left its `atticus ui` server running. On Windows only the shell around it was stopped; now the whole process tree is, and the server also stops by itself when the window that started it goes, even if VS Code is killed.

## 0.3.0

- **Draft the org pack from the wikis**: the systems the knowledge names, with their aliases and owners, to pick and accept into profile.yaml.
- **Check what no one has verified**: the unverified knowledge items, one after another.
- Next runs the new steps: sync an old wiki again, draft or accept the org pack, check the knowledge your changes use.
- Correct… also edits an item's links (label=address) and other names.
- Adding a wiki and bringing in a repo ask what to do next in a dialog, not a notification that slips into the bell.

Knowledge managed in the metarepo, and what a change needs from the organisation (ADR 0101).

- **Add a wiki or docs repo…** (the + in the Knowledge section, Start or bring in, and Add knowledge): a git repo (an Azure DevOps or GitHub wiki, or a docs repo), a folder of pages, or Confluence or SharePoint. It asks where, its name, the folder and branch to read, clone or submodule, what it is about and who owns it, saves it into `sources.yaml`, and offers to sync and read it with Copilot. Confluence and SharePoint only show their entry: their adapter isn't wired to the command line yet.
- **Sources** each show their last snapshot and the commit read, with **Sync it**, **Read it with Copilot** and **Tag it…**.
- **Items** by kind (requests and processes, standards and patterns, decisions and constraints, teams, vendors, products and projects), each with its review: a green tick, "check again", or rejected. Click one to open the page it was read from at the quote. **Verify**, **Correct…** (each field shown with its value now), **Reject…**, **Open its links** (request forms and catalogue items the page gave) and **Ask about it**.
- **What the last scan changed**: new, changed and gone items, and the reviews to check again.
- **Search the wikis…**: a term or phrase; Copilot reads the pages it is on for what isn't an item yet. Pick what to keep and what as. Saved searches are listed under **Searches** to come back to.
- **A change's needs**: under each change, **Needs (n open)**, or **Find what it needs** before they are found. Each need with what it is for, its lead time and who handles it, a tick when its item was verified, why (quoting the change) and how. **Done…**, **Not needed…**, **Reopen**, **Open its links**, **Open the item's page**. **Raise a change's open needs…** goes through them one by one.
- **Next**: every step listed runs when clicked, not only the first; each keeps its Run button. Finding a change's needs runs with Copilot; raising them opens the list of open needs. Both are named in plain words, with the change's title.
- **Set up**: the org pack's owner step opens `pack.yaml` at `owner:`; clicking the checklist does its next step.
- The sections follow the knowledge folder and the org pack as they change.

## 0.2.0

- **Start or bring in**, the + in the Next section: create a metarepo, use Atticus in a repo, a practice metarepo, add repos, onboard a repo, bring in another team's repo, accept it, add knowledge.
- **Set up** in Next: the setup checklist until the catalog is accepted; click a step to do it.
- **Onboard a repo** (a repo's checklist button): its stages in order, each with its state. Pick one to run it; the list comes back updated.
- **Bring in from another repo**: another metarepo, an OpenSpec, Spec Kit or TypeSpec repo, or a repo of prompts, agents, skills and checklists. A dry run in plain words first, then the proposal's summary, then Accept.
- A next step with a part to fill in opens the screen that asks for it.
- Steps name changes by their titles; questions raised again lead with what differs; an empty section's row is its first step.
- With no metarepo open, only the Next section shows, so its welcome fits.
- Fixed: the sections refreshed only once a run's notification was closed. A made metarepo now opens (or asks where) instead of a notification that slipped into the bell.

## 0.1.1

- Fixed: clicking the app's menu and links in the Atticus tab did nothing. VS Code cancels every click on a `#…` link inside a panel; the app now follows its own links there itself.
- First-run help: a Get started walkthrough, and welcome screens to create, adopt or open a metarepo.
- Add repos; plain words for the next step and the command list; a Questions section; shortcut keys.
- The Atticus tab follows VS Code's light, dark and high-contrast themes.

## 0.1.0

The first version.

- **Run the AI steps with Copilot's model** (ADR 0090): `@atticus` in Copilot Chat runs a step's whole loop. It stops only when the step is done or a question needs a person.
- **The Atticus app in a tab, from the extension's own files** (ADR 0091, 0097): the Architecture canvas, flows as sequence diagrams, a change's target flows before and after, and every other screen. The app's calls go through the extension to the local Atticus service.
- **The sidebar** (ADR 0093, 0096):
  - **Next**, with the open questions.
  - **Repos**, down to every flow step. A step opens its code.
  - **Changes**, with files, tasks, target flows and findings. You can act on a finding, and **New change** starts one.
  - **Knowledge** and **Catalog**.
- **In the code** (ADR 0093, 0094): above each cited line, which flow step and which catalog records cite it.
- **Every command** (ADR 0096): Run a command, and `@atticus /run`, offer every command the command line has, each argument picked from a list. A write to a shared system shows its dry run and waits for your yes.
- **When the window opens:** the upgrade and machine checks.
