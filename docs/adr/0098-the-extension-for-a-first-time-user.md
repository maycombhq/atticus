# 0098. The VS Code extension for a first-time user: start from nothing, plain words, Questions, and tests in VS Code

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0090, 0093, 0096 and 0097 (the VS Code extension)

## Context

A review of the extension found that it covered every command (ADR 0096) but was not yet friendly to someone using it for the first time:

- It only woke up in a folder that already held a metarepo, so `atticus init` and `atticus adopt` couldn't be run from it.
- Adding repos meant editing YAML by hand.
- It didn't say when the command line or Copilot Chat was missing.
- It spoke in commands (`Next: atticus scan verify nadiengine --accept`).
- Its command list led with syntax and included the developers' own commands.
- The open questions sat inside the Next section.
- It had no shortcut keys, and had never been tested inside VS Code itself.

## Decision

1. **Start from nothing.** When no metarepo is open, the sections are empty and VS Code shows their welcome: **Open a metarepo**, **Create a metarepo** (`atticus init`, asking where, its name and its platform, then offering to open it), **Use Atticus in this repo** (`atticus adopt`, which writes only `.atticus/`), and **Try a practice metarepo** (`atticus sandbox create`). The service no longer treats any open folder as a metarepo; only a folder with `org-pack/` or `.atticus/org-pack/` is one.
2. **Missing tools are said.** Three context keys (`atticus.cliMissing`, `atticus.hasMetarepo`, `atticus.copilotOk`) are kept up to date: `atticus --version` runs on activation, and again when folders or extensions change.
   - Without the command line, the Next section shows how to install it, a link to set `atticus.path`, and Check again.
   - Without Copilot Chat in a window with a metarepo, a message offers to install it.
3. **A walkthrough** (Get started with Atticus) takes a person from an empty machine to a planned change, a button at each step:
   1. install the command line;
   2. install Copilot Chat;
   3. open or create a metarepo;
   4. add repos;
   5. scan;
   6. draft specs;
   7. start a change.

   Each step completes when its context key is set or its command runs. The extension also activates on startup, so the walkthrough sees what is set up.

4. **Add repos** (the Repos section's +) finds them in a folder of clones or a Git host organisation with `atticus repos discover`. It shows each repo found with its type, from the dry run, and adds them to the platform's manifest only when the person says yes. The manifest can still be opened and edited by hand.
5. **Plain words.**
   - The next step says what it does ("Review and accept nadiengine's scan proposal"), with its reason and command in the tooltip. The steps after it follow under it.
   - Run a command leads with what each command does, with the command and how it runs beside it. The commands only Atticus's own developers use are hidden unless `atticus.showDeveloperCommands` is on.
6. **A Questions section:** the open questions by repo, each one answered by a click. A repo has "Answer this repo's questions", one after another.
7. **Shortcut keys:** Ctrl+Alt+Shift+A runs a command, Ctrl+Alt+Shift+N the next step, Ctrl+Alt+Shift+D opens the app (Cmd on macOS).
8. **Tests inside VS Code.** `pnpm --filter atticus test:vscode` makes a practice metarepo (sandbox, sync, scan), then starts a VS Code with its own profile and only this extension. It runs `test-vscode/suite.ts` there and checks:
   - the extension finds the metarepo and the command line;
   - every declared command is registered;
   - Next speaks in plain words;
   - Repos, Changes and Catalog read the metarepo;
   - the app opens in a tab from the extension's own files, with its policy and no token.

   `activate` returns handles for this. A manifest test checks that every `command:` link in the welcome views and the walkthrough names a command that exists.

9. **Fixed: the app's links in a panel.** The bundled page had a `<base>`, so the app's own links (`#/architecture`) pointed at another page, and VS Code refused to go there: clicking the menu did nothing. The page now gives its files their full address and has no `<base>`. Checked by clicking the menu in the panel harness (ADR 0097): each screen opened.
10. **The app follows VS Code's theme in a panel.** Every colour in the app is a theme token (`packages/ui/src/styles/hud.css`). A test fails on a colour literal outside the token blocks, and on a light text token below 4.5:1. VS Code marks the panel's body `vscode-light`, `vscode-dark`, `vscode-high-contrast` or `vscode-high-contrast-light`, and the light and high-contrast token sets apply under those marks. With no mark (the browser) the app is as before: 36 screens were compared colour by colour, and axe found no contrast issue in any of the four themes.
11. **No contract changes.**

## Consequences

- Someone with nothing installed is led from the command line to a first change. Every state of the sidebar says what to do next.
- First run in a real VS Code (VS Code 1.95+, Windows) passed all seven checks.
- Not built here: an IntelliJ plugin (a follow-up).
