# Atticus in IntelliJ IDEA

The IntelliJ plugin does the same work as the VS Code extension: the same commands, the same tool window, the same checks. Two things only VS Code does, and they are named at the bottom.

Install it from Settings → Plugins (search for Atticus), or from the zip the release gives you. It needs the `atticus` command line on this machine (`npm install -g @maycombhq/atticus`, from your npm mirror, or the offline bundle); Settings → Tools → Atticus sets the path when it is somewhere else. The plugin calls no model itself and makes no network call of its own: it runs `atticus` here and shows the app `atticus ui` serves on 127.0.0.1.

## The tool window

**View → Tool Windows → Atticus**, on the right. Nine tabs, in the order of a working day (ADR 0105):

| Tab                | What it shows                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Next**           | The next step and the setup checklist. Double-click a row, or **Run the Step**, to take it.                                                                                                                                                                                                                  |
| **Waiting on you** | The questions to answer, each change's open needs, open findings and manual steps, and the knowledge nobody has checked. Grouped by change by default; **Group Waiting by Kind** switches, and it is remembered.                                                                                             |
| **Changes**        | Each change with its state, where its work is, its risk and the kinds of test it needs. Open a change for its tasks, and a task for the knowledge pages that apply to it. OpenSpec stores' changes are listed read-only, with their task counts.                                                             |
| **Repos**          | Every repo of the manifests with what it is, in a person's words; a line your assistant drafted is marked unconfirmed until you confirm it. Below them, the calls that go through gateways: the whole path, each hop with its auth, the scopes its route demands and which side it faces.                    |
| **Knowledge**      | The wikis and docs repos of `sources.yaml` first — **Sync This Source**, **Read This Source with Copilot** and **Tag This Source…** act on the row you pick — then the knowledge items, the ones nobody has checked before the rest, with **Verify**, **Correct…**, **Reject…** and **Ask About This Item**. |
| **Model runs**     | What Atticus asked a model, what it answered and what the checks handed back.                                                                                                                                                                                                                                |
| **Prompt history** | What people asked their assistant in this metarepo. Claude Code's (with the Atticus plugin) and `@atticus`'s in VS Code are recorded; Copilot's chats in IntelliJ cannot be — see below.                                                                                                                     |
| **App**            | The Atticus app itself, every screen of it, in the panel.                                                                                                                                                                                                                                                    |
| **Output**         | Every command the plugin ran and what it printed.                                                                                                                                                                                                                                                            |

**Filtering.** Waiting on you, Changes, Knowledge and Model runs have **Filter…** and **Clear filter** in their toolbars: words to match an item's title, id, change or repo, in any case. Repos, Next and Prompt history have no filter box — their lists are short, and the tree's own type-to-find is enough.

## What is native

Everything with a name of its own is in **Tools → Atticus**, and in **Find Action** (Ctrl+Shift+A / ⇧⌘A) by its own words. In the order of the menu:

- **What is next**: Next Step, Run the Step.
- **Read a repo and check it**: Read a Repo with Copilot, Verify a Repo's Facts, Survey a Repo, Verify a Repo's Last Scan, Draft a Repo's Spec, Say What a Repo Is, Onboard a Repo…, Add Repos, Scan Every Repo, Join the Estate's Flows, Clone or Update the Base Clones, Accept the Catalog….
- **A change, stage by stage**: New Change…, Feature Stage, Architecture Stage, Write a Change's Stories, Small Change's Fast Path, Review with the Critic, Find What a Change Needs, Run a Task, Start a Task in Copilot, Change Diagram, Estimate, Watch a Change…, Attach to Atticus Change…, Act on the Finding, Need Done / Not Needed… / Reopen, Raise a Change's Open Needs…, Show the Manual Step.
- **What the organisation knows**: Add Knowledge…, Add a Wiki or Docs Repo…, Sync the Knowledge Sources, Sync / Read / Tag This Source, Scan the Knowledge Sources, Ask the Knowledge, Ask About This Item, Verify / Correct / Reject This Item, Draft the Org Pack from the Wikis…, Name the Org Pack's Owner, Bring In from Another Repo…, Accept What Was Brought In…, Add to Atticus Knowledge (on the files you pick in the Project view).
- **The catalog, the machine and the digest**: Ask the Catalog…, Check This Machine and the Metarepo, Upgrade the Metarepo, Send What Waits on You.
- **Getting started**: Create a Metarepo…, Use Atticus in This Project, Try a Practice Metarepo….

Two more: **Run a Command…** runs any `atticus` command, picking it from the list, which is the job when you want to run something on a repo or a change that has no action of its own; and the **gutter** beside a line of code says which flows and records cite it, and what breaks if it changes.

A command that writes to a shared system runs as a dry run first and runs for real only after you click **Approve and run**. That never changes, whichever action started it.

## The AI steps: Copilot, or Claude Code

An AI step (reading a repo, a stage's draft, the critic's lenses, the knowledge scan, what a change needs) needs a model. Atticus runs none itself. In IntelliJ a step offers, in this order:

1. **GitHub Copilot Chat.** The step's slash command goes on the clipboard — or, where `atticus assistant-files` hasn't written its prompt file yet, the prompt itself. Open Copilot Chat (⌥⇧C / Alt+Shift+C), paste, send. The notice also names **the kind of step and the model that kind expects** (your field in Settings → Tools → Atticus, else `models.<kind>` in `runtime.yaml`): pick it in Copilot's own model picker before you send. Copilot writes the answer where the prompt says, and `atticus` then checks it exactly as it checks any assistant's answer.

   **What Atticus cannot do here, plainly:** GitHub Copilot's IntelliJ plugin publishes nothing a third-party plugin can call. Atticus cannot open the chat with your prompt already in it, cannot send it, cannot read what you and Copilot said (so nothing typed in Copilot reaches the Prompt history) and cannot choose Copilot's model for you. The clipboard, the notice and the model's name are the whole of it. Where the IDE happens to have Copilot's "open chat" action registered, the notice offers **Open Copilot Chat** as a convenience — that is the one programmatic thing, and when it isn't there, nothing is offered and nothing is implied.

2. **Claude Code in a terminal.** **Run it in Claude Code in a terminal** opens `claude` in the metarepo with the same slash command. The Atticus plugin for Claude Code answers it, and Claude Code's prompts and replies _are_ recorded in the Prompt history.

3. **Atticus's configured model**, where your `runtime.yaml` allows model mode: Atticus runs the step itself, in a console here, on `models.<kind>` (your settings reach it as `ATTICUS_MODEL_<KIND>`).

4. **The hand-off on its own**: `atticus <step> --handoff` writes the prompt and the result file for a model run anywhere, and the notice offers to open the prompt.

## What only VS Code does

Two, and both are about VS Code's own APIs rather than anything missing here:

- **Set up GitHub Copilot.** VS Code has Copilot built in from 1.143, and the extension can install the chat extension in an older one. IntelliJ's Copilot is a Marketplace plugin, and a plugin cannot install another; Atticus says where to get it instead (Settings → Plugins → GitHub Copilot).
- **Pick the model.** VS Code lends an extension its language models, so the extension can list them and call the one you choose. IntelliJ lends a plugin none, and Copilot's plugin exposes no picker, so Atticus names the model a step expects and you pick it in Copilot's own picker — or let Atticus run the step on `runtime.yaml`'s model.

Everything else VS Code's sidebar, code lenses and chat participant do has a place here: a view, an action, a screen of the app, or a line in this guide saying why not. ADR 0105 addendum 2 holds the table, and a test fails if it stops being true.
