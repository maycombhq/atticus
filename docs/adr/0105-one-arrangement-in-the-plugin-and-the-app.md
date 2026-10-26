# 0105. One arrangement in the plugin and the app, in the order of a working day (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0084 (the app's six screens; "every other page stays under More until it is reviewed"), 0093 (the extension's sections), 0101 and 0102 (knowledge and needs), 0104 (the Claude Code plugin)

## Context

ADR 0084 cut the app's menu to six screens and left the rest under More until reviewed. Since then knowledge, needs, the org pack from the wikis and the Claude Code plugin arrived, and both surfaces grew in the order features were built rather than the order a person works:

- The VS Code sidebar reads Next, Questions, Repos, Changes, Knowledge, Catalog. The daily work (changes) is fourth; what waits on the person is only its questions, while open needs, manual steps, open findings and unverified knowledge are spread inside each change or not shown. Bring in (absorb another metarepo, OpenSpec or TypeSpec repo) sits in the Knowledge menu; Knowledge's title bar has nine actions.
- The app's More has one Know group of fifteen screens mixing what the code says, what the wikis say and setup. The list of changes is under More, Build. Home (what needs a person) is under More, beside the Dashboard. A change's needs show only one change at a time. The Dashboard names Copilot Chat as the only place the slash commands are.

## Decision

Both surfaces use one arrangement, in the order of a working day: what is next, what waits on me, my changes, what the organisation knows, then the estate and its setup.

### The VS Code extension's sidebar

1. **Next**: the next step and the setup checklist (unchanged).
2. **Waiting on you** (was Questions): a row group for each kind, each with its count, each empty group said in words or left out:
   - **Questions** to answer (as before);
   - **Needs** still open, across every change (`atticus needs --all --json`, open ones), each opening its page or its need, with Done and Not needed;
   - **Manual steps** to do (`atticus todo --json`), each opening the step;
   - **Findings** open on any change (`atticus findings <change> --json` for each open change), each opening its change;
   - **Knowledge to verify**: the count of unverified items, opening Check what no one has verified.
     The view id stays `atticus.questions`, so settings and keybindings that name it keep working.
3. **Changes** (moved up from fourth).
4. **Knowledge**. Its title bar keeps Add a wiki, Search the wikis, Read the sources and Sync as buttons; the rest go in the overflow menu in three groups: reading (Ask the knowledge, Keep what a search found), reviewing (Check what no one has verified), the org pack (Draft the org pack from the wikis). Bring in moves out.
5. **Repos**, with Bring in from another repo in its overflow menu.
6. **Catalog**.

### The app's menu

- **Main:** Dashboard, **Waiting on you** (the page at `#/home`, renamed from Command center), **Changes** (`#/changes`), then the phase screens Onboarding, Feature design, Architecture, Stories, Tasks, then **Knowledge** (`#/knowledge`).
- **More**, regrouped:
  - **Code:** Explore, Flows, Map, Impact, Features, Scans.
  - **Knowledge:** Knowledge sources, Search the wikis, Teams, vendors and products (Knowledge items is in Main).
  - **Org pack:** Org pack, Org pack from the wikis, Intake, Settings.
  - **Define**, **Design**, **Plan**, **Build**, **Release** as before, without Changes (now in Main).
  - **Run:** Governance, Evals, Learning.
  - **Questions** joins Waiting on you's page as a section link and stays at `#/questions`.
- **Needs across changes:** the cross-change view (`#/changes?across=…`) gains **Needs**: every open need of every change, grouped by change, with its kind, who handles it, lead time, verified or not, and Done, Not needed and Reopen as on a change's page.
- **The slash commands card** on the Dashboard says the commands are in Copilot Chat (from `atticus assistant-files`) and in Claude Code (the Atticus plugin, ADR 0104).

No route is removed or renamed; only where each sits in the menu, and two labels, change.

## Consequences

- A person opens either surface and reads, top down, what to do next, what waits on them across every change, then their changes.
- What waits on a person is in one place in both surfaces, not inside each change.
- The More menu says which screens are about the code, the wikis and the org pack.

## Addendum: grouped by change, and a filter where lists grow (2026-10-23)

With many changes, a list by kind and an unfiltered list both get too long to use.

- **Grouped by change by default.** Waiting on you lists each change with its open needs, open findings and manual steps under it, in that order, changes with something blocking first. What belongs to no change follows in its own group: questions (by repo), manual steps with no change, and knowledge to verify. In the VS Code extension a title bar button switches between By change and By kind, and the choice is remembered for the workspace. In the app, Waiting on you's list of what needs a person is grouped the same way.
- **A filter wherever a list grows.** One box, the same words in both surfaces ("Filter: words to match, for example forge-ledger"), matching an item's title, id, change and repo, case-insensitively:
  - the extension: Waiting on you, Changes and Knowledge, through a Filter… title bar button; the view's description shows the filter, a Clear filter button removes it, and an empty result says what was filtered and offers to clear it;
  - the app: Questions (with a repo picker beside it), Manual steps, and Waiting on you's list, beside the filters the cross-change views and Knowledge items already have.

## Addendum 2 (2026-10-26): what parity means in the IntelliJ plugin

### Context

The product owner uses IntelliJ at the bank and asked for the IntelliJ plugin to be kept, and kept updated the same as the VS Code extension, with the AI steps runnable through Copilot there too.

`core/Parity.kt` had tracked VS Code command by command since WP6.3, and `ParityTest` kept the table honest about _coverage_. It was not honest about _parity_: 47 of the 95 commands resolved to `InIntelliJ.RunCommand` — Tools → Atticus: Run a Command… — including everything added in the last few days (a task's knowledge, a repo's description, the gateway path of a call, the OpenSpec export, the verify step, task runs). "You can reach it by picking a command out of a list of 174" is not the same job as a named action or a view, and a table that said it was made the gap invisible.

### Decision

**Each VS Code command resolves to one of six things, and `RunCommand` is not a default.**

| Where it is done                             | Commands | What it means                                                                                                                                                  |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Action(id)` — a native action in plugin.xml | 76       | Its own entry in Tools → Atticus and in Find Action, with its own words; the job is done here, with the target asked for and the command run as its kind needs |
| `App(hash)` — a screen of the app            | 9        | The app's own screen in the tool window, where the screen _is_ the surface (the wiki search, a need's page, a flow's diagram)                                  |
| `Tab(name)` — a tab of the tool window       | 6        | A native tree is the surface: the command's job is "show me this list"                                                                                         |
| `Dialog(where)` — part of a dialog or a flow | 1        | `runApproved` is the Approve and run button of the dry-run dialog (ADR 0099), not a command of its own                                                         |
| `RunCommand`                                 | 2        | Running a command _is_ the job; the two are named below                                                                                                        |
| `VsCodeOnly(why)` — a stated limit, with why | 2        | `installCopilot` and `pickModel`, both for reasons that are about VS Code's own APIs                                                                           |

**The two `RunCommand` entries that are left**, each an explicitly command-shaped step:

- `atticus.repoCommand` — "Run on this repo…": pick any `atticus` command and run it on the repo whose row you are on. Picking the command is the point.
- `atticus.changeCommand` — "Run on this change…": the same for a change.

`Parity.RUN_COMMAND_BUDGET` is 2 and `ParityTest` fails if the count rises or if the two change, so a later ticket cannot quietly park new work in Run a Command. `ParityTest` still fails when VS Code gains a command the table doesn't place, when it names an action that isn't in plugin.xml, a screen that isn't in the app or a tab that doesn't exist, and when a `VsCodeOnly` entry gives no reason.

**The native actions come from one table.** `core/Steps.kt` holds every job the plugin does with an action of its own: the AI steps (`map`, `scan survey`, `scan verify`, `spec draft`, `change feature`, `change architecture`, `plan stories`, `change small`, `critic`, `knowledge scan`, `knowledge ask`, `change needs`, and a question about one knowledge item) and the commands Atticus runs itself (`verify`, `repo describe`, `ask`, `scan`, `estate join`, `workspace sync`, `sources sync`, `sources add`, `sources tag`, `upgrade`, `doctor`, `digest`, `repos discover`, `absorb`, `absorb accept`, `onboard`, `baseline`, `orgpack draft`, `orgpack owner`, `todo show`, `knowledge verify`, `knowledge correct`, `knowledge reject`, `needs done`, `needs skip`, `needs reopen`, `task run`). Each is one line there, one line in plugin.xml and one line of Kotlin, and `Parity.MAP` is built from it, so an action in the table and missing from plugin.xml fails the test.

A step that needs a repo or a change asks for it from the manifests or from `change list`; a non-AI step then goes through the command catalogue, so its options are asked and its kind is honoured — a shared write still does its dry run and waits for the person's yes (ADR 0099, safety rule 6), and nothing about approvals changes.

**One Atticus menu.** The actions sit in a `popup` group under Tools, in the order of a working day (what is next; read a repo and check it; a change, stage by stage; what the organisation knows; the catalog, the machine and the digest; the trees' filters and grouping), which is the arrangement this ADR already chose for both surfaces.

### The views

The tool window has nine tabs, in that same order: **Next**, **Waiting on you**, **Changes**, **Repos**, **Knowledge**, **Model runs**, **Prompt history**, then **App** (the app's screens) and **Output**. Each tree reads the command line in the background and has an empty, a loading and an error row.

What the last few days' work shows in them:

- **Changes**: each change with its state, its work line (B-change), its risk level and score, and the kinds of test it requires, from `atticus change status --json`. A change opens to its tasks, and a task opens to the knowledge pages that apply to it (B-task-knowledge) — ranked, each with its page and section, the pages that also say it, and the conflict question a person is asked when pages disagree. The OpenSpec stores' changes are listed as read-only with their task counts, and `atticus openspec check`'s own lines are rows beneath them (ADR 0126).
- **Repos**: every repo of the manifests with what a person says it is, a drafted description marked "drafted by your assistant, unconfirmed" (ADR 0128), and `atticus repo describe --json` folded in. Beneath them, the calls that go through gateways: the path `caller → route → route → service`, each hop with its auth, the scopes its route demands and which side it faces (ADR 0124 addendum A-gateway2).
- **Waiting on you**: the questions, each change's open needs, open findings and manual steps, and the knowledge no one has checked — **grouped by change by default and by kind when asked**, changes with something blocking first, exactly as this ADR's first addendum says. A need's row has Done, Not needed (with why) and Reopen; a finding's row has the critic's own actions (apply, I fixed it by hand, not relevant, waive where the finding says it may be and the rule is not a constitution rule, ask someone).
- **Model runs** and **Prompt history**: `atticus runs --json` and `atticus history --json`. The history's empty row says plainly that Copilot's chats in IntelliJ can't be recorded.

**Filters and grouping.** Waiting on you, Changes, Knowledge and Model runs each have Filter… and Clear filter, with this ADR's words ("Filter: words to match, for example forge-ledger"), matching an item's title, id, change and repo case-insensitively; an empty result says what was filtered and how to clear it. Waiting on you has By change and By kind, remembered in the settings. Repos, the Next tab and Prompt history have no filter box: their lists are short and the tree's own speed search is enough — a limit, said here rather than left unsaid.

### Consequences

- 47 Run a Command entries became 2. Every other command has a name, a place and a test.
- A new VS Code command fails `ParityTest`, and placing it in Run a Command fails `ParityTest` too, so the next ticket has to choose a real place for it.
- Tools → Atticus has about sixty entries. That is the same order of magnitude as VS Code's command palette, and it is why they are in one submenu, grouped with separators, rather than in the Tools menu itself.
