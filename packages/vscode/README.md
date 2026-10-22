# Atticus for VS Code

Run Atticus's AI steps with GitHub Copilot's own model, without pasting prompts. The extension runs a step's whole loop: Atticus prepares the prompt, Copilot's model answers, Atticus checks the answer and hands it back when it is wrong, and the model drafts again. It stops only when the step is done, when a question needs a person, or when something stops it, and it says why.

Atticus's command line does all the checking. The extension only carries the prompt to the model and the answer back (ADR 0090).

## What you need

- VS Code 1.95 or later, with the GitHub Copilot Chat extension, signed in.
- The `atticus` command line on your PATH (or its path in the setting `atticus.path`), Node 22.13 or later.
- Your metarepo open in VS Code: the folder with `org-pack/` (or `.atticus/org-pack/`). The extension starts when that folder is open.

## Install

The extension isn't on the Marketplace. Install it from the `.vsix` file:

1. In VS Code, open the Extensions view, click `...` at the top, and pick **Install from VSIX...**.
2. Choose `atticus-<version>.vsix`.

Or in a terminal: `code --install-extension atticus-<version>.vsix`.

To build the file from the source: `pnpm --filter atticus package` (it writes `packages/vscode/atticus-<version>.vsix`).

## Try it

1. Open the metarepo folder.
2. Open Copilot Chat and type `@atticus /next`. It shows the next step and a button to run it.
3. Click the button (or type, for example, `@atticus /survey forge-notes`). The first time, VS Code asks whether Atticus may use the Copilot model: allow it.
4. Watch the step run in the chat. When it stops at a question, click an answer, then run the step again.

## In Copilot Chat

| Command                           | What it does                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `@atticus /next`                  | The next step, from `atticus next`, with a button to run it                              |
| `@atticus /survey <repo>`         | Draft the repo's scan settings (`atticus scan survey`)                                   |
| `@atticus /verify <repo>`         | Compare the repo's code with its last scan (`atticus scan verify`)                       |
| `@atticus /spec <repo>`           | Draft the repo's spec, then `atticus spec check`; draft again on findings, up to 3 times |
| `@atticus /feature <change>`      | The change's feature stage (`atticus change feature`)                                    |
| `@atticus /architecture <change>` | The change's architecture stage (`atticus change architecture`)                          |
| `@atticus /stories <change>`      | The change's stories and tasks (`atticus plan stories`)                                  |
| `@atticus /answer`                | Each open question with its options as buttons; a click runs `atticus questions answer`  |
| `@atticus /ask <question>`        | A plain question to the catalog (`atticus ask`); no model is used                        |

Without a repo or change, a step command takes the one `atticus next` names for that step.

## The side view

The Atticus icon in the activity bar opens a view with the next step (click it or its Run button), the open questions (click one to answer: pick an option or write your own words), and **Open the app** (starts `atticus ui` in a terminal and opens it in your browser).

The same actions are in the Command Palette under **Atticus:**. Every `atticus` command the extension runs, with its exit code, is in the **Atticus** output.

## Settings

| Setting         | Default   | What it is                                                                                                                                                                                                                            |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atticus.path`  | `atticus` | The `atticus` command: a command on PATH, its full path, or the path to its `bin.js` (run with `node`). On Windows the extension reads the `atticus.cmd` that npm or pnpm writes and runs the `bin.js` it names, so no shell is used. |
| `atticus.model` | empty     | A Copilot model family, for example `gpt-4o`. Empty: the model picked in Copilot Chat, else the first Copilot model.                                                                                                                  |

## What is sent where

- **To the Copilot model, through VS Code's Language Model API (`vscode.lm`):** a step's prompt file as Atticus wrote it, after one line from the extension that asks for only the result file's content. The prompt holds what the step read from your metarepo and repos. Nothing else is sent to the model, and nothing goes to the model without your consent (VS Code asks the first time).
- **To the `atticus` command line, on this machine:** the commands in the output. They read and write files in the metarepo, as they do in a terminal.
- **Nowhere else.** No telemetry. The extension makes no network call of its own, except to check that the app it started answers on `127.0.0.1`.

A prompt longer than the model takes is never cut: the extension says so and stops, and the run waits, so you can finish it another way. Cancel stops the step; nothing more is sent or written.

## What it doesn't do

- It doesn't check anything itself. Every check is Atticus's.
- It runs `/atticus-onboard`, `/atticus-knowledge`, `/atticus-task` and `/atticus-release` steps only when `atticus next` names them (Run in the view or the chat): there is no chat command for them yet.
- It isn't on the Marketplace, and it has only been tested with a fake model and the real command line, not inside VS Code.
