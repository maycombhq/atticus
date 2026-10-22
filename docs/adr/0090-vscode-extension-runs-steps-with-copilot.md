# 0090. A thin VS Code extension runs the AI steps with Copilot's model, and `--handoff --json`

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0086 (every step as a slash command, `--handoff`, `atticus next`), ADR 0087 (change stages as loops), revamp plan principle 8 and section 4.8

## Context

At the bank, the GitHub Copilot plugin is the only AI tool. ADR 0086 made every AI step a slash command: Copilot's model reads the printed prompt, writes the result file, runs `atticus handoff done` and resumes the step. That works, but it relies on Copilot's agent mode following a long prompt file, running commands in the right order and stopping at the right place, and each editor and model version does that a little differently (plan section 6). In VS Code, an extension can call Copilot's own model through VS Code's Language Model API (`vscode.lm`), with the person's consent, so a step's loop can run without the person pasting prompts and without the model having to run commands.

Plan 4.8 lists an `@atticus` chat participant as "later, only if the bank allows it". The product owner asked for it now, as a thin extension.

`atticus <step> --handoff` printed five lines meant for a person or an assistant, and printed the step's own output when nothing was handed off. A tool running the loop needs that in a form it can read without parsing sentences.

## Decision

1. **`atticus <step> --handoff --json`** prints one JSON object:
   - when the step hands a run off: `state: "handoff"`, `runId`, `root`, `promptFile` and `resultFile` (relative to the root), `doneCommand` and `resumeCommand` (as a person types them), `doneArgs` and `resumeArgs` (the same as argv, without `atticus`), the step's `messages`, and `stillWaiting: true` when the step was resumed before its result was written;
   - otherwise the step's end: `state` is `question` when the step raised an open question, asked one again or named one in its output; else `done` (exit 0), `stopped` (exit 1) or `failed` (exit 2 or more, or the step threw). With `exitCode`, `messages` (its stdout lines), `errors` (its stderr lines) and `questions` (id, repo, question, options, evidence, the answer command).
     The step itself runs without `--json`, so its messages are the words a person reads. The exit code is the step's own (0 for a hand-off). Without `--json` nothing changes.
2. **The extension (`packages/vscode`, published name `atticus`)** is a runner, not a checker. For a step it runs `atticus <step> … --handoff --json --root <metarepo>`, reads the prompt file, sends it to a Copilot chat model (`vscode.lm.selectChatModels({ vendor: "copilot" })`, the family in the setting `atticus.model`, else the model picked in Copilot Chat, else the first), writes the model's whole answer to the result file, runs the done command and then the resume command, and goes round while the step hands off again (at most 8 rounds). It stops when the step is done, raises a question, stops or fails, and shows why. Before the prompt it sends one line of its own: reply with only the result file's content, because the extension writes the file and runs the command. `/spec` runs the draft, then `atticus spec check`, and drafts again on findings, up to three drafts (ADR 0086 point 1).
3. **It never cuts a prompt.** A prompt over the model's `maxInputTokens` stops the step with the two numbers; the run stays waiting with its resume command. Cancel kills the running command or stops reading the model, and writes nothing. A refused consent stops the step and says so.
4. **Surfaces:** a chat participant `@atticus` with `/next`, `/survey`, `/verify`, `/spec`, `/feature`, `/architecture`, `/stories`, `/answer` (each open question with its options as buttons that run `atticus questions answer`) and `/ask` (`atticus ask`, no model); a side view with the next step and a Run button, the open questions and Open the app (`atticus ui` in a terminal, then the browser); the same actions in the Command Palette; and an output channel with every command run and its exit code.
5. **What goes where.** The only thing sent off the machine is the step's prompt, to the Copilot model through `vscode.lm`. No telemetry. Everything read from the repo is data: Atticus's output is shown in the chat inside code blocks, never rendered as markdown. On Windows the `atticus.cmd` shim is read for the `bin.js` it starts, which is run with `node`, so arguments (a person's answer in their own words among them) never pass through a shell; when that isn't possible, an argument with a shell character is refused with a message.
6. **No contract changes.** No record, org-pack, plugin SDK, local API or AI runtime schema changes. `--handoff --json` is a new command output, like `atticus next --json`.

## Consequences

- In VS Code a step's loop runs from one chat command or one click, with Copilot's model and the person's consent, and stops only for a person. IntelliJ IDEA keeps the slash commands of ADR 0086.
- The extension is built with `tsc` to CommonJS files in `dist/` (esbuild isn't in the repo), packaged with `vsce package --no-dependencies`; it has no runtime dependencies. It is installed from the `.vsix`, not the Marketplace.
- Its tests run the loop with a fake model against the real command line; nothing runs inside VS Code in CI. The chat participant, the view and the consent prompt are untested code.
- The `vscode` module is provided by the editor, not npm. The dependency check (`scripts/check-deps.mjs`) must accept it for the extension package.
- `atticus next` names some steps (knowledge, task, release) that have no chat command; the extension runs the AI ones from Run and shows the rest.
