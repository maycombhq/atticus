# 0099. An IntelliJ IDEA plugin: the app in a tool window, every command, AI steps in Copilot Chat

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0090, 0096, 0097 and 0098 (the VS Code extension)

## Context

People at the target organisation use IntelliJ IDEA or VS Code, with GitHub Copilot in both. ADR 0098 left the IntelliJ plugin as a follow-up.

The VS Code extension runs AI steps with Copilot's model through VS Code's Language Model API. GitHub Copilot in IntelliJ has no such API for plugins. So an IntelliJ plugin can't run an AI step's loop itself.

## Decision

1. **A plugin in Kotlin** in `packages/intellij`, built with Gradle (the wrapper is committed) and the IntelliJ Platform Gradle Plugin 2.x. Its plugin id is `com.maycombhq.atticus` and its name is Atticus.
   - It is built against the IntelliJ IDEA installed on the machine (`atticus.ideaPath`), with that IDE's JetBrains Runtime, so no IDE is downloaded. IntelliJ IDEA Community is downloaded only when that folder is missing.
   - It produces Java 21 class files and declares since-build 253.29346 (2025.3.1). That is the first build with the `com.intellij.modules.jcef` alias, which 2026.2 needs for the embedded browser.
2. **The Atticus tool window:**
   - **In a metarepo** (a project with `org-pack/` or `.atticus/org-pack/`), the tool window starts `atticus ui --port 0 --root <project>` the first time it opens. It reads the address the app prints, which must be on 127.0.0.1, and shows the page in JCEF. The process stops when the project closes.
   - **Without a metarepo,** it offers Create a metarepo (`atticus init`), Use Atticus in this project (`atticus adopt`) and Try a practice metarepo (`atticus sandbox create`), as ADR 0098 does in VS Code.
   - **Without the command line,** it says how to install it and offers the path setting.
   - **An Output tab** lists every command run, with what it printed. The app's session token is masked.
3. **Run a Command…** lists `atticus commands --json` by area, plain words first, without the developer commands (ADR 0098). It asks each argument, then the required options, then any options to add. Every command gets `--root`, except the three that make a metarepo. How a command runs depends on its kind:
   - **AI steps (`runs: ai`) are not run.** The plugin names the slash command for Copilot Chat (`/atticus-survey`, `/atticus-verify`, `/atticus-spec`, `/atticus-knowledge`, `/atticus-feature`, `/atticus-architecture`, `/atticus-stories`, `/atticus-plan`) and can copy it. It can also run the step's `--handoff` in a console instead. The plugin calls no model.
   - **Shared writes (`runs: shared`)** run first without their approve flag, as a dry run. The plugin shows what the dry run said, and runs the command with `--approve` or `--send` only after the person clicks **Approve and run**. If the dry run failed, it offers no approval. This keeps the rule that a person approves every write to a shared system.
   - **Servers (`runs: serve`)** run in the Run tool window with a Stop button, not in a shell terminal. That way, as everywhere else, no shell is used.
   - **Everything else** runs in the background. The plugin notifies the first line it printed, with Show output for the rest.
4. **Next Step** reads `atticus next --json` and shows the step in the extension's words. It offers what fits the step: copy the slash command or run the hand-off for an AI step; open the app for questions or a person's step; Run for a command, by the rules above.
5. **No shell.** `atticus` runs as a process with its arguments as they are. On Windows the plugin reads the `bin.js` from the `atticus.cmd` that npm, pnpm or the offline bundle writes, and runs it with `node`. Only a shim it can't read goes through the shell, and then an argument with a shell character is refused.
6. **The logic is tested without the IDE.** Reading JSON, the command list, `atticus next`, the plain titles, building the arguments, how each command runs, finding `atticus` and its shim, the manifest's repos and the app's address are plain Kotlin in `core/`, with JUnit 5 tests. The IDE code in `ide/` only asks and shows. The user-facing words are in `core/Copy.kt`.
7. **No contract changes.** No telemetry and no network calls of its own. The plugin only runs `atticus` and shows 127.0.0.1.

## Consequences

- People using IntelliJ have the app, every command, the next step and the approval of shared writes in the IDE. They type an AI step in Copilot Chat themselves.
- The Plugin Verifier finds the plugin compatible with IntelliJ IDEA 2026.2. It notes 4 uses of deprecated API and 6 of experimental API, which are still to be listed and replaced.
- Not done yet:
  - running the plugin inside the IDE;
  - tree views for questions, repos and changes, and CodeLens (the app in the tool window covers them);
  - the upgrade and doctor checks when a project opens;
  - publishing to the JetBrains Marketplace.
