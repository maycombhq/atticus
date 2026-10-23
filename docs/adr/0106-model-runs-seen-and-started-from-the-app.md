# 0106. Model runs seen everywhere, and started from the app where a model can be reached (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0090 (the extension runs the steps with Copilot), 0091 and 0097 (the app in a VS Code panel, and its bridge), 0102 (the app for knowledge and needs: AI steps shown as commands to copy), 0074 (the AI reads; every answer is checked), 0103 (attempts carried across a hand-off)

## Context

An AI step's prompt and answers are kept on disk: each round's `prompt.md` and result file under `.runs/<change>/<run>/`, and a hand-back prompt holds the previous answer and the problems the checks found. Nothing shows them. A person sees progress lines in a notification or the Atticus output, and has to know where the files are to read what was asked and answered. Run from the sidebar, a step never appears in the Copilot Chat window.

The app shows an AI step's command and slash command to copy, and never starts one (ADR 0102). Its server can reach a model only when the org pack's `runtime.yaml` configures one (Anthropic, OpenAI-compatible, Azure OpenAI or Bedrock). Copilot's models are reachable only inside VS Code, through the extension, which is where the app also runs, in a panel.

## Decision

1. **Model runs, read-only, in the local API**, beside the run routes that exist (`GET /api/runs/{runId}`, done, retry, cancel). `GET /api/runs` lists the runs under `.runs/`, newest first (`?change=` for one change or step, `?limit=`): each with its change or step, run id, agent, runtime, state, started and finished, its round (the attempt, carried across hand-offs, ADR 0103), whether it was answered, how many problems were handed back to it, and the prompt's size; and `serverModel`, the model this server can run a step with, or null. `GET /api/runs/{runId}/transcript` gives one run's prompt, its answer (wherever its runtime wrote it, never outside the change folder), the problems each earlier round handed back with the answer that failed them, and every round of the same step. Text from a prompt or an answer is data: the app shows it as text, never as markup. Additive; API_VERSION 2.8.0.
2. **A Model runs screen in the app** (More, Run, and linked from each AI step's page): the list, filterable like the app's other lists, and one run with its prompt, answer and problems side by side, round by round. It works in a browser and in a VS Code panel.
3. **Starting an AI step from the app, where a model can be reached:**
   - **In a VS Code panel:** a **Run with Copilot** button on the step. The app asks the extension through the bridge (a new message, `run-step`, with the step's command words and arguments; the extension accepts only the catalogue's AI steps and refuses any argument that starts with `-`). The extension runs it as the sidebar does (Copilot, the person's consent, the checks), and posts progress and the end back to the panel.
   - **In a browser, when `runtime.yaml` configures a model** (`adapters.model`, and `modes.allowed` includes `model` when it is set): a **Run with \<model\>** button. `POST /api/runs` with the step's command words and arguments starts it on the server with the model runtime, as a job (`/api/jobs/{jobId}` follows it, kind `step`); the page follows the job and shows the run when it ends. Only the AI steps are accepted (the hand-off steps), any argument that starts with `-` is refused, and without a model the answer is 409 with what to do instead.
   - **Otherwise** (a browser with Copilot only, as at a bank that allows only Copilot): the command and slash command to copy, as today.
     A step started from the app writes only what the same command writes (the metarepo's own files); every write to a shared system still needs a person's approval.
4. **The VS Code extension shows its runs:** each run's notification and its `@atticus` chat reply get **Open the prompt** and **Open the answer** (the last round's files); a **Model runs** section, collapsed at the bottom of the sidebar, lists the runs and opens one in the app's Model runs screen, or its files.

## Consequences

- A person can always see what Atticus asked a model and what it answered, and why an answer was handed back.
- In VS Code, the app is a place to run the steps, not only to read them; in a browser it runs them only where the organisation configured a model.
- ADR 0102's "the app doesn't run AI steps" now holds only where no model can be reached.

## Addendum: the same in every surface (2026-10-23)

ADR 0105's Waiting on you, grouped by change with a filter, and this ADR's model runs reach all four surfaces, each with what it can do:

|                                          | The app                                                                                               | VS Code                                                  | IntelliJ IDEA                                                                                                                                      | Claude Code                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Waiting on you, by change, with a filter | Waiting on you (`#/home`)                                                                             | its sidebar section                                      | the app in its tool window, and a **Waiting on you** action that opens it                                                                          | the `waiting_on_you` MCP tool (by change or by kind, a filter); the session start says how much waits |
| Needs across changes                     | `#/changes?across=needs`                                                                              | in Waiting on you                                        | the app's view                                                                                                                                     | the `open_needs` MCP tool                                                                             |
| Model runs                               | the Model runs screen                                                                                 | Open the prompt, Open the answer, the Model runs section | the app's screen, a **Model runs** action that opens it, and Open the prompt after a hand-off it ran                                               | the `model_runs` and `model_run` MCP tools; a step Claude runs itself is in its own chat              |
| Run an AI step                           | Run with Copilot in a VS Code panel; Run with the server's model in a browser where one is configured | the sidebar, the palette, `@atticus`                     | the app's Run with the server's model where one is configured; else the slash command in Copilot Chat (Copilot in IntelliJ gives plugins no model) | Claude runs it, with the slash command                                                                |

The MCP tools stay read-only (ADR 0104): they read what waits and what ran; the steps that change anything are the commands.

The critic is an AI step too. `atticus critic <change>` leaves one run waiting per AI lens, so `--handoff` offers them one at a time, oldest first: each resume reads in the answers there are and offers the next lens of the same change, and the last ends with the gate's verdict. Every surface's Run therefore reviews a change (`critic --resume` and `critic stats` stay a person's commands). `atticus task run` stays a command: it edits a repo's code, so it runs in the assistant's agent mode, where a person watches each edit, not as one prompt and one answer.

A step started on the server names the run it made in its job's result (`runId`), so the app links to that run.
