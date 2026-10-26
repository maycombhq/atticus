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

## Addendum (2026-10-26): the Copilot agent-mode command in the arrangement

ADR 0121's addendum of the same date adds **Atticus: Run the next step in Copilot's agent mode**
(`atticus.runInCopilotAgent`) beside **Run the next step**: the same step, handed to Copilot's agent
mode instead of to the `@atticus` participant. It is an everyday command of the Command Palette
(`DEFAULT_PALETTE` in `packages/vscode/src/surface.ts`, second after **Run the next step**, so the
order of a working day still reads "what's next, run it, run it in the agent"), not behind
`atticus.fullUi`, and it adds no view and no menu. Nothing is removed and no existing command moves.
