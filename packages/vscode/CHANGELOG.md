# Changelog

The Atticus extension for VS Code. The command line's own changes are in the repository's [CHANGELOG](https://github.com/maycombhq/atticus/blob/main/CHANGELOG.md).

## 0.3.1

Nothing a person clicks leaves them unsure.

- **The sidebar in the order of a working day** (ADR 0105): Next, Waiting on you, Changes, Knowledge, Repos, Catalog. Changes moves up from fourth.
- **Waiting on you** (was Questions; the view id `atticus.questions` stays, so settings and keybindings that name it keep working): what waits on you across every change, a group for each kind with its count. **Questions** by repo, as before; **Needs** still open on any change, each naming its change and opening `needs.md` at it, with **Done…** and **Not needed…**; **Manual steps** to do, each opening what `atticus todo show` says, with **Record it…**; **Findings** open on any open change, blocking first, each opening its change, with its check button; and **Knowledge to verify**, how many items no one has verified, opening **Check what no one has verified**. An empty group is left out, and when nothing waits one row says so. It shows "Reading…" until read, says why a part couldn't be read, and refreshes with the other sections.
- **Knowledge's title bar** keeps four buttons (Add a wiki, Search the wikis, Scan the knowledge sources, Sync the knowledge sources); the rest are in its menu in three groups: reading (Ask the knowledge, Keep what a search found), reviewing (Check what no one has verified) and the org pack (Draft the org pack from the wikis).
- **Bring in from another repo…** moves from the Knowledge menu to the Repos menu.
- **Waiting on you, by change** (ADR 0105 addendum), the default: each change with something open, with its title, id and count, and under it its open needs, open findings and manual steps, in that order; changes with a blocking finding first, then by title. Then **Not part of a change**: the questions by repo, manual steps with no change, and knowledge to verify. Each row keeps its buttons. **Group by kind** in the title bar switches to the layout by kind, and **Group by change** back; the choice is remembered for the workspace.
- **Model runs** (ADR 0106): a section collapsed at the bottom of the sidebar lists what Atticus asked a model and what came back (`atticus runs --json`), newest first: each run's step or change, agent, round, state, whether it was answered and how many problems were handed back. A run opens to **Open the prompt**, **Open the answer** and **Open in the app** (the app's Model runs screen on that run). It has its own **Filter…**, shows "Reading…" until read, says why when it can't be read, and reads again when a step ends.
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
