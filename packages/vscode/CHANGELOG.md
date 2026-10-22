# Changelog

The Atticus extension for VS Code. The command line's own changes are in the repository's [CHANGELOG](https://github.com/maycombhq/atticus/blob/main/CHANGELOG.md).

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
