# Changelog

The Atticus extension for VS Code. The command line's own changes are in the repository's [CHANGELOG](https://github.com/maycombhq/atticus/blob/main/CHANGELOG.md).

## 0.3.0

- **Draft the org pack from the wikis**: the systems the knowledge names, with their aliases and owners, to pick and accept into profile.yaml.
- **Check what no one has verified**: the unverified knowledge items, one after another.
- Next runs the new steps: sync an old wiki again, draft or accept the org pack, check the knowledge your changes use.

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
