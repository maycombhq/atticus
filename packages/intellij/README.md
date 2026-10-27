# Atticus for IntelliJ IDEA

The Atticus app in a tool window, the views VS Code's sidebar has, an action for every job, and the next step in plain words (ADR 0099, ADR 0105 addendum 2). It does what the VS Code extension does, except two things, both about VS Code's own APIs: installing Copilot, and picking the model an extension calls. GitHub Copilot in IntelliJ gives plugins no model and no chat to call, so here an AI step goes to Copilot Chat on the clipboard with its `/atticus-*` slash command (`atticus assistant-files` writes the prompt files) and the model its kind expects named for you to pick; or to Claude Code in a terminal with the same slash command; or, where `runtime.yaml` allows model mode and names a provider, Atticus runs it on that model in a console here (ADR 0121 addendum 2). The plugin itself never calls a model.

The full guide is [docs/guide/intellij.md](../../docs/guide/intellij.md).

## What you need

- IntelliJ IDEA 2025.3.1 or later. The Plugin Verifier finds it compatible with 2025.3.6 and 2026.2.3, with no deprecated or experimental API. Other JetBrains IDEs on the same platform should work, but haven't been tried.
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
- **The tabs** (ADR 0105 addendum 2), in the order of a working day: **Next**, **Waiting on you**, **Changes**, **Repos**, **Knowledge**, **Model runs**, **Prompt history**, then **App** and **Output**. Each is a native tree that reads the command line in the background, with a row for what it is doing while it reads, for nothing to show, and for why it couldn't read. Waiting on you, Changes, Knowledge and Model runs have **Filter…** and **Clear filter**; Waiting on you also has **By change** and **By kind**, remembered.
- **Tools → Atticus** holds an action for every job, each also in Find Action by its own words: the AI steps (read a repo, survey, verify the last scan, draft a spec, the four change stages, the critic, the knowledge scan and ask, what a change needs) and the commands Atticus runs itself (verify the facts, say what a repo is, onboard, add repos, scan, join the estate, sync the base clones, accept the catalog, the knowledge reviews, the needs, draft the org pack, bring in another repo, ask the catalog, doctor, upgrade, digest). **Run a Command…** is for when picking the command is the point.
- **After a hand-off** run in the console, a notification opens the prompt it wrote, or the app's Model runs.
- **Attach to Atticus Change…** (ADR 0113): right-click files in the Project view or an editor tab, pick the change, and `atticus change attach` copies them into its `inputs/`, where its steps read them as data, cited by line or page.
- **Add to Atticus Knowledge** (ADR 0122): right-click files in the Project view or an editor tab. `atticus intake add` copies them into the metarepo's `inputs/inbox/`: general knowledge, read by the next sync and the knowledge scan.
- **Atticus: Start a Task in Copilot** (the Tools menu, ADR 0113): pick the change and the task; the plugin reads `atticus task context` and puts it on the clipboard, with `/atticus-task <change> <task>` to copy. Paste either into Copilot Chat in agent mode. Copilot in IntelliJ gives plugins no way to open its chat, so the plugin can't do that for you.
- **The Waiting on you tab** (WP6, ADR 0105 addendum): the questions to answer, each change's open needs, open findings and manual steps, and the knowledge no one has checked, read from `atticus waiting`, `atticus needs --all`, `atticus findings <change>` and `atticus todo --all`. Grouped by change by default, changes with something blocking first. Double-click a question to answer it, or a change's row to open its At a glance page. With a row picked, **Need Done**, **Need Not Needed…** (with why), **Reopen the Need** and **Act on the Finding** (the critic's own actions: apply the fix, I fixed it by hand, not relevant, waive it where the finding says it may be, ask someone — never a constitution rule) act on it.
- **The Changes tab**: each change with its state, where its work is, its risk and the kinds of test it needs (`atticus change status --json`). Open a change for its tasks, and a task for the knowledge pages that apply to it (`atticus task context --json`): ranked, each with its page and section, the pages that also say it, and the question asked when pages disagree. The OpenSpec stores' changes are read-only, with their task counts (ADR 0126).
- **The Knowledge tab**: the wikis and docs repos of `org-pack/sources.yaml`, then the knowledge items (`atticus knowledge list --json`), the ones nobody has checked first. With a source picked, **Sync This Source**, **Read This Source with Copilot** and **Tag This Source…**; with an item picked, **Verify / Correct… / Reject This Item** and **Ask About This Item**.
- **The Repos tab**: every repo of the manifests with what it is in a person's words, a line your assistant drafted marked unconfirmed (ADR 0128), and `atticus repo describe --json` folded in. Below them, the calls that go through gateways (`atticus estate join --json`): the whole path, each hop with its auth, the scopes its route demands and which side it faces (ADR 0124 addendum A-gateway2).
- **The Output tab** lists every `atticus` command the plugin ran, with what it printed and its exit code. The app's session token is kept out of it.

**The status bar** says how many questions wait, the next step and how many changes you watch, as VS Code's does; its tooltip says how each watched change is doing, and a click shows the next step.

**Atticus: Answer a Question…** (the Tools menu and the Waiting tab): pick an open question, then answer it in a dialog with each choice and what it means, or in your own words, beside the lines it read. It runs `atticus questions answer`.

**Atticus: New Change…** asks for the title, then offers the archived changes nearest it (`atticus change similar`); one you pick is attached as an example (`--like`). **Atticus: Watch a Change…** follows a change without being on it (`atticus watch`). Create a metarepo, Use Atticus in this project and Try a practice metarepo are actions too, and Use Atticus in this project asks first.

**In the editor's gutter** (WP7.3): when a file of the metarepo's workspace opens, a mark on each line a spec flow or a catalog record cites (`atticus cites --file`). Its tooltip names the flows, the changes in flight on them and the records; a click opens the flow, a change, or what breaks if it changes, in the app. A line with a change in flight has a warning mark.

**Atticus: Run a Command…** (the Tools menu, the tool window's toolbar, or Find Action, Ctrl+Shift+A). It reads `atticus commands --json` and lists every command by area, with what it does first and the command beside it. Atticus's own developer commands are hidden unless you turn them on in the settings.

1. The plugin asks for each argument:
   - each list is searchable: type to narrow it, or type a value that isn't in it;
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

- An AI step: copy its slash command, run it on Atticus's configured model (where model mode is allowed), or run its hand-off. When the metarepo has no Copilot prompt file for the slash command, it says so and offers to write them (`atticus assistant-files`).
- Open questions: open the app, or copy `/atticus-answer`.
- A command: run it, by the same rules as above.
- A step only a person takes: open the app, or copy the command.

**Settings → Tools → Atticus**:

- The path to `atticus`, with Browse and **Check** (runs `atticus --version` with the path as typed). Leave it empty to use `atticus` on PATH, or give its full path: `atticus`, `atticus.cmd` or its `bin.js`.
- Whether to show the developer commands.
- Whether to say, when a project opens, that the command line can't be found (the notice has **Don't show again** too).

The next step is read in the background, so the IDE never waits on it.

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

The plugin is written to `build/distributions/atticus-intellij-<version>.zip`. Its version is set in `build.gradle.kts` (0.2.0); it doesn't follow the command line's version.

- **Another IDE folder:** pass `-Patticus.ideaPath=<folder>`, or set `atticus.ideaPath` in `~/.gradle/gradle.properties`. When that folder doesn't exist, the build downloads IntelliJ IDEA 2025.3.6 instead (about 1.5 GB, 4 GB unpacked) and needs a JDK 21. It is the one IntelliJ IDEA distribution, free without a licence: IntelliJ IDEA Community isn't published on its own from 2025.3.
- **Checking the plugin against the IDE:** `./gradlew verifyPlugin`. With a local IDE it checks that one (add `"-Porg.gradle.java.installations.paths=<IDE folder>/jbr"`). Without one, pick the IntelliJ IDEA versions with `-Patticus.verifyIdes=2025.3.6,2026.2.3`; left out, it checks the Marketplace's recommended set, four IDEs of about 4 GB each unpacked. The verifier runs `-offline`: the plugin needs nothing from the Marketplace, so none of its plugins are downloaded.
- **Running it:** `./gradlew runIde -Patticus.openProject=<metarepo>` starts a sandbox IDE with the plugin, that folder open. `./gradlew runIdeForUiTests` does the same with JetBrains' Remote Robot server on 127.0.0.1:8082 (`/hierarchy` shows the UI's tree, `/js/retrieveAny` runs a script in the IDE). The sandbox's settings are in `.intellijPlatform/sandbox/`; put `options/atticus.xml` in its `config_runIdeForUiTests` folder to set the path to `atticus` before it starts.

The first build downloads Gradle 9.7.1 (about 130 MB, plus about 30 MB more once unpacked), the IntelliJ Platform Gradle Plugin, the Kotlin compiler and JUnit. Together that is about 600 MB in `~/.gradle`, plus the IDE when it is downloaded.

The logic is in `src/main/kotlin/com/maycombhq/atticus/core`, with JUnit 5 tests in `src/test`. It covers:

- reading the command list and `atticus next`;
- the plain titles;
- building the arguments;
- how each command runs;
- finding `atticus` on PATH and reading its shim;
- the address `atticus ui` prints.

None of it needs the IDE. The IDE parts, in `ide/`, only ask and show. The user-facing words are in `core/Copy.kt`.

## What it doesn't do yet

- **What was run in an IDE** (IntelliJ IDEA 2025.3.6 on Linux, under Xvfb, with a practice metarepo open, on 2026-10-25): the plugin loads; the startup read (`next`, `waiting`, `watch`) fills the status bar; the tool window opens with its three tabs; the app starts on 127.0.0.1 with its token hidden in the Output tab and stops with the IDE; the Waiting tab reads `atticus waiting --json`; opening a file runs `atticus cites` for the gutter; all 18 actions register (11 in the Tools menu, 2 in the Project view's menu); Next Step shows its dialog with the slash command, the hand-off and the missing prompt file; Run a Command… lists the commands; the settings page saves the path and Check finds `atticus`. No exception from the plugin in `idea.log`.
- **Still for a person to click through:** the app's page in the panel (JCEF suspends itself when the IDE runs as root, as it did here, so the page wasn't seen; it was served), a Waiting tree with rows and the answer dialog, the gutter's marks and their popup, Run a Command… taken through its arguments to a run, Approve and run, a hand-off in the Run tool window, Attach to Atticus Change… and Add to Atticus Knowledge on real files, Start a Task in Copilot, and the panels with no metarepo or no `atticus`. And on Windows and macOS. **The seven new tabs, the Tools → Atticus menu and the sixty-odd actions of ADR 0105 addendum 2 have not been clicked through in the IDE either**: `./gradlew test` and `./gradlew verifyPlugin` were run, nothing more.
- Run a Command… lists every command by area. It doesn't yet list the twelve first, as VS Code does (`legacy` in `atticus commands --json`).
- Copilot's IntelliJ plugin publishes nothing a plugin can call: Atticus can't open its chat with the prompt in it, send it, read it (so nothing typed in Copilot reaches the Prompt history) or choose its model. An AI step is a paste, with the model its kind expects named; where the IDE has Copilot's open-chat action registered, the notice offers to open the chat. The other ways are Claude Code in a terminal, Atticus's configured model, and the hand-off.
- Repos, the Next tab and Prompt history have no filter box: their lists are short, and the tree's type-to-find is enough.
- The gutter reads files in the metarepo's own workspace (`workspace/<repo>/`, a change's worktree, another branch's checkout) or an adopted repo; a code repo opened as its own project, away from the metarepo, gets no marks.
- It doesn't check whether the metarepo needs `atticus upgrade` or run `atticus doctor` when the project opens.
- Every VS Code command has its place here, listed in `core/Parity.kt` and checked by `ParityTest`: 76 native actions, 9 screens of the app, 6 tabs, 1 dialog button, 2 Run a Command entries (`repoCommand` and `changeCommand`, where picking the command is the job) and 2 VS Code only — picking one of VS Code's language models, and installing Copilot in VS Code. A budget test fails if the Run a Command count rises above the 2 ADR 0105 addendum 2 records.
