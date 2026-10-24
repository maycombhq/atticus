# Atticus for IntelliJ IDEA

The Atticus app in a tool window, every `atticus` command from a menu, and the next step in plain words (ADR 0099). It does what the VS Code extension does, except one thing: GitHub Copilot in IntelliJ gives plugins no model to call. So in IntelliJ the AI steps run in Copilot Chat, with the `/atticus-*` slash commands that `atticus assistant-files` writes. Where `runtime.yaml` allows model mode and names a model provider, an AI step can also run on that model: Atticus's command line calls it, in a console here (ADR 0121). The plugin itself never calls a model.

## What you need

- IntelliJ IDEA 2025.3.1 or later (built against 2026.2). Other JetBrains IDEs on the same platform should work, but haven't been tried.
- The `atticus` command line on your PATH, or its path in **Settings → Tools → Atticus**. Node 22.13 or later. [How to install it](../../docs/guide/install.md), including the offline bundle.
- For the AI steps: GitHub Copilot in IntelliJ, and the prompt files in your metarepo (`atticus assistant-files`).

## Install

1. Build the plugin (below), or get `atticus-intellij-<version>.zip` from whoever builds it.
2. In IntelliJ IDEA, open **Settings → Plugins**, click the ⚙ (gear) button, and pick **Install Plugin from Disk…**.
3. Choose the zip, then restart the IDE when it asks.

## What it does

**The Atticus tool window** (on the right):

- **In a metarepo** (a project with `org-pack/` or `.atticus/org-pack/`), the first time you open the tool window, the plugin starts `atticus ui --port 0 --root <project>` in the background. It shows the app in the panel (JCEF). The app listens on 127.0.0.1 only, and the plugin stops it when the project closes.
- **With no metarepo open**, it offers three ways to start:
  - **Create a metarepo** (`atticus init`): it asks where, the name and the platform, then offers to open it.
  - **Use Atticus in this project** (`atticus adopt`): writes only `.atticus/`.
  - **Try a practice metarepo** (`atticus sandbox create`): invented repos to try Atticus on.
- **When `atticus` can't be started**, it says how to install it and has a button for the path setting.
- **The toolbar:** Refresh, Open in browser, Run a command…, Next step, **Waiting on you** (what waits on you across every change, grouped by change, with a filter: the app's page), **Model runs** (what Atticus asked a model, what it answered, and what the checks handed back) and **Prompt history** (ADR 0110: what people asked their assistant in the metarepo and what it answered, as Claude Code with the Atticus plugin and `@atticus` in VS Code recorded it; Copilot in IntelliJ gives plugins no chat, so nothing typed here is recorded). All three are in the Tools menu too.
- **After a hand-off** run in the console, a notification opens the prompt it wrote, or the app's Model runs.
- **Attach to Atticus Change…** (ADR 0113): right-click files in the Project view or an editor tab, pick the change, and `atticus change attach` copies them into its `inputs/`, where its steps read them as data, cited by line or page.
- **Atticus: Start a Task in Copilot** (the Tools menu, ADR 0113): pick the change and the task; the plugin reads `atticus task context` and puts it on the clipboard, with `/atticus-task <change> <task>` to copy. Paste either into Copilot Chat in agent mode. Copilot in IntelliJ gives plugins no way to open its chat, so the plugin can't do that for you.
- **The Output tab** lists every `atticus` command the plugin ran, with what it printed and its exit code. The app's session token is kept out of it.

**Atticus: Run a Command…** (the Tools menu, the tool window's toolbar, or Find Action, Ctrl+Shift+A). It reads `atticus commands --json` and lists every command by area, with what it does first and the command beside it. Atticus's own developer commands are hidden unless you turn them on in the settings.

1. The plugin asks for each argument:
   - repos: a list from `org-pack/profiles/*/repos.manifest.yaml`;
   - changes: a list from `atticus change list --json`;
   - open questions: a list from `atticus questions list`;
   - choices: their values;
   - paths: a folder or file picker;
   - anything else: a text field.
2. Then it asks for the options the command needs: a change's type comes from `org-pack/change-types.yaml`, and a platform from the profiles.
3. Then any options you want to add. Every command gets `--root <metarepo>`, except `init`, `adopt` and `sandbox create`.

How it runs depends on the command:

| The command                                                                                               | What the plugin does                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An AI step (survey, verify, spec, knowledge, feature, architecture, stories, the fast path, change draft) | Says which slash command to type in Copilot Chat (for example `/atticus-survey forge-web`) and has a button that copies it, with one line saying how AI steps run here. Where model mode is allowed and a provider is set, **Run it on Atticus's configured model** runs the step with `--mode model` in a console. Or it can run the step's hand-off (`--handoff`) in a console. |
| A write to a shared system (hand-off PR, sync, work items, task run, digest)                              | Runs it first without `--approve` or `--send`, as a dry run, and shows what the dry run said. It runs again with the flag only after you click **Approve and run**. If the dry run fails, there is nothing to approve.                                                                                                                                                            |
| A server (`ui`, `stub serve`)                                                                             | Runs in the Run tool window, with a Stop button.                                                                                                                                                                                                                                                                                                                                  |
| Anything else                                                                                             | Runs in the background. A notification gives the first line it printed, with **Show output** for the rest. After `change new`, the brief opens in the editor.                                                                                                                                                                                                                     |

**Atticus: Next Step** reads `atticus next --json` and says what the next step does in plain words, for example "Review and accept nadiengine's scan proposal". Below that come the reason and the command. What you can do from there depends on the step:

- An AI step: copy its slash command, run it on Atticus's configured model (where model mode is allowed), or run its hand-off.
- Open questions: open the app, or copy `/atticus-answer`.
- A command: run it, by the same rules as above.
- A step only a person takes: open the app, or copy the command.

**Settings → Tools → Atticus** has two settings:

- The path to `atticus`. Leave it empty to use `atticus` on PATH, or give its full path: `atticus`, `atticus.cmd` or its `bin.js`.
- Whether to show the developer commands.

## How it runs `atticus`

The plugin runs `atticus` without a shell, so an argument with spaces or quotes reaches it as it is. On Windows it reads the `atticus.cmd` that npm, pnpm or the offline bundle writes, and runs the `bin.js` it names with `node`. For a shim it can't read, the command goes through the Windows shell, and an argument with one of `" % ^ & | < > !` is refused.

## What is sent where

- **To the `atticus` command line, on this machine:** the commands in the Output tab.
- **To the app it started, on 127.0.0.1:** the page in the tool window.
- **Nowhere else.** No telemetry, no other network calls, and no model calls.

## Build

You need a JDK 17 or later to run Gradle. The build compiles against the IntelliJ IDEA installed on this machine, with the IDE's own JetBrains Runtime (Java 25 for 2026.x), so no IDE is downloaded.

```sh
cd packages/intellij
./gradlew test buildPlugin        # gradlew.bat on Windows cmd
```

The plugin is written to `build/distributions/atticus-intellij-<version>.zip`.

- **Another IDE folder:** pass `-Patticus.ideaPath=<folder>`, or set `atticus.ideaPath` in `~/.gradle/gradle.properties`. When that folder doesn't exist, the build downloads IntelliJ IDEA Community 2025.3.6 instead (about 1 GB), and needs a JDK 21.
- **Checking the plugin against the IDE:** run `./gradlew verifyPlugin "-Porg.gradle.java.installations.paths=<IDE folder>/jbr"`. It uses the local IDE, but it downloads about 550 MB of Marketplace plugins into `~/.pluginVerifier`, which you can delete afterwards.

The first build downloads Gradle 9.7.1 (about 130 MB, plus about 30 MB more once unpacked), the IntelliJ Platform Gradle Plugin, the Kotlin compiler and JUnit. Together that is about 600 MB in `~/.gradle`.

The logic is in `src/main/kotlin/com/maycombhq/atticus/core`, with JUnit 5 tests in `src/test`. It covers:

- reading the command list and `atticus next`;
- the plain titles;
- building the arguments;
- how each command runs;
- finding `atticus` on PATH and reading its shim;
- the address `atticus ui` prints.

None of it needs the IDE. The IDE parts, in `ide/`, only ask and show. The user-facing words are in `core/Copy.kt`.

## What it doesn't do yet

- It has been compiled and checked with the Plugin Verifier against IntelliJ IDEA 2026.2 ("Compatible"), but it hasn't been run inside the IDE yet.
- There are no Questions, Repos or Changes tree views like the VS Code sidebar, and no CodeLens. The app in the tool window covers them.
- It doesn't check whether the metarepo needs `atticus upgrade` or run `atticus doctor` when the project opens.
