# 0096. Every command in the editor: `atticus commands --json`, Run a command, and the sidebar's actions

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0090 (the VS Code extension), ADR 0093 (its sidebar), ADR 0086 (every step as a slash command)

## Context

The VS Code extension covered the AI steps, the flows, the changes' files and findings, and the catalog. It could not start a change, and it could not run most of Atticus's 160 commands. The product owner found the gaps one at a time ("how do I start a new change?") and asked for the extension to be complete, so that everything Atticus does can be done from it.

A button for each command would always lag behind the command line. The command line already describes every command in its help text: the words, the arguments, the options and what each does.

## Decision

1. **`atticus commands [--json]`** turns the help text into a catalogue.
   - **What each command records:**
     - its words and usage, and what it does;
     - each argument: its name, whether it is optional or takes many, and what kind it is (a repo, a change, a flow, a system, a question, a finding, a record, a path, a choice of values, or text);
     - each option: its value, whether it is required, and what it does;
     - its area: set up, repos and specs, knowledge, the catalog, changes, plans, release, or Atticus's own quality;
     - how it runs: `ai`, a step an assistant does (it takes `--handoff`); `shared`, a write to a shared system once a person adds its approve flag (`--approve`, `--send`), and otherwise a dry run; `serve`, it keeps running; `local`, everything else.
   - **How it stays complete:** a test fails if a command in the help has no area, so a new command can't be left out. Two forms of the same words are named by the option that sets them apart (`critic --resume`, `absorb --refresh`).
2. **Run a command** (the Command Palette, the Next section's title bar, and `@atticus /run <command…>` in chat) offers every command, by area.
   - **Pickers:** each argument is asked with a picker for its kind: the repos of the manifests and specs, the changes, the open questions, a change's open findings, the flows, the systems, a file or folder, or the values of a choice. Required options come next (a change's type from `org-pack/change-types.yaml`), then any options to add.
   - **How a command runs:**
     - AI steps run with Copilot's model, as before (ADR 0090).
     - A shared write runs as a dry run. The extension then shows what the dry run says and asks the person before it runs again with the approve flag. In chat, the dry run's output comes back with an Approve button, and the same question in the editor follows.
     - A server gets a terminal.
     - Everything else runs, and what it printed goes to the Atticus output, or back into the chat.
   - **In chat**, the words typed after `/run` fill the arguments and options. When some are missing, a button fills them in from the pickers.
3. **The sidebar's actions.**
   - **Changes:** the title bar has New change. It asks for the title and the type, runs `atticus change new`, opens the brief to write, and then offers the feature stage. `@atticus /new <title>` does the same from chat.
   - **On a repo or a change:** each has "Run on this repo/change…", which lists every command whose first argument is a repo or a change, with it filled in.
   - **Under a change:** a change now also lists its Tasks, each with "Run the task".
   - **Knowledge:** a new section with the sources (from `sources.yaml`) and the knowledge items (each opens its file), and in its title bar sync, scan and ask.
   - **Repos:** the title bar has scan every repo, join the estate's flows, and update the base clones.
   - **Next:** the title bar has Run a command, the machine and metarepo check, the setup checklist, what waits on you, and upgrade.
4. **Health when the window opens.** `atticus upgrade --check` and `atticus doctor --json` run once. A pending upgrade, or a check of this machine that isn't ok, is said with its fix and a button.
5. **What is offered agrees with what is registered.** A test checks that every command in a menu or the palette is declared, and every declared command is registered.
6. **No contract changes.** `atticus commands` is a new command's output; the extension reads existing API routes and commands.

## Consequences

- Everything the command line does can be done from VS Code. A command added to the command line appears in Run a command as soon as the command line has it.
- A write to a shared system always shows its dry run and waits for a person's yes, from any part of the extension (CLAUDE.md rule 6).
- The catalogue is parsed from help text, so a help line written in another shape would be parsed wrongly. The catalogue's tests pin the shapes the help uses, and the "every command has an area" test catches a command the parser misses.
- Not built: a form per command (the pickers ask one thing at a time), and IntelliJ.
