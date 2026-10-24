# 0110. Prompt and response history, kept on this machine (C4, C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0106 (model runs: what Atticus's own steps ask a model), 0104 (the Claude Code plugin and its read-only MCP tools), 0090 (the `@atticus` chat participant), 0050 (the local log and `.atticus/.gitignore`), 0105 (one arrangement in the plugin and the app)

## Context

Model runs (ADR 0106) show what Atticus's own steps ask a model and what came back. They say nothing about what a person types to their assistant while working in a metarepo, or what it answered: the product owner wants that history recorded and trackable beside the model runs, so a team can see how a change was worked on and find a prompt that worked again.

What each assistant lets Atticus see differs:

- **Claude Code** runs a plugin's hooks on every prompt (`UserPromptSubmit`, with the prompt, the session id and the transcript's path on stdin) and at the end of every reply (`Stop`, with the session id and the transcript's path; the reply is the transcript's last assistant message).
- **VS Code with Copilot** gives an extension the requests sent to its own chat participant, `@atticus`, and the reply it streams. It gives no extension any access to Copilot's other chats: what a person asks Copilot directly can't be recorded by Atticus.
- **IntelliJ with Copilot** gives plugins no chat at all (ADR 0106 addendum).

## Decision

1. **One record per prompt and per response**, appended as one JSON object per line to `.atticus/history/<yyyy-mm>.jsonl` in the metarepo. `history/` joins the local-only entries `.atticus/.gitignore` keeps out of Git (`LOCAL_ONLY`, ADR 0050), so the history stays on this machine and is never committed by default; `atticus upgrade` adds the line to an older metarepo. A record holds its id (`h-<yyyymmddhhmmss>-<6 hex>`), when (`at`), the surface (`claude-code`, `vscode` or `cli`), the session, the kind (`prompt` or `response`), the text, its size in bytes as given, the slash command when there is one, and the change it is about when that can be told exactly: the one change id of the metarepo its text names, else the metarepo's branch `change/<id>`; never a guess.
2. **The text is data, never instructions.** Nothing reads a record as a prompt; every surface shows it as text. One record keeps at most 64 KB of text; a longer one is cut there and marked `truncated`, with its full size. Before a record is written its text goes through the secret patterns the local log uses (`redactText`, ADR 0050): what matches is masked (`***`) and the record is marked `masked`, so the screen says so. Nothing is removed silently.
3. **Recording is configuration, not a safety rule.** It is on by default. The org pack turns it off for everyone with `history: { record: false }` in `runtime.yaml` (an additive, optional key: no schema version bump, as with `buildEngine`); a person turns it off on their machine with `atticus history off` (`history.record: false` in `.atticus/me.yaml`), and on again with `atticus history on`. Either one off means nothing is recorded. Off, `history add` writes nothing and says why.
4. **The commands.** `atticus history add --surface <s> --kind prompt|response [--session id] [--command c]` reads the text from stdin and appends one record; the hooks and the VS Code extension call it, so only the command line writes the files. `atticus history [--change id] [--session id] [--filter words] [--limit n] [--json]` lists the turns (a prompt with the response that followed it in the same session), newest first; `atticus history show <id> [--json]` prints one record and its pair.
5. **The surfaces.**
   - **Claude Code:** the plugin's `UserPromptSubmit` and `Stop` hooks, only inside a metarepo (the SessionStart hook's test: `org-pack/` or `.atticus/org-pack/` above the project folder). They print nothing, so nothing is added to the conversation, and a failure never stops a prompt. A reply told twice in a row with no prompt between (the transcript read before its newest message was written) is kept once. The read-only MCP tool `prompt_history` lists the turns (ADR 0104: additive).
   - **VS Code:** every `@atticus` request and the reply the extension streamed, through `atticus history add`. A chat's requests share one session while the chat goes on; a new chat starts another. Copilot's chats outside `@atticus` are not recorded: VS Code gives extensions no access to them, and the screen says so. **Atticus: Open the prompt history** opens the screen in the Atticus tab.
   - **IntelliJ:** an **Atticus: Prompt History** action opens the screen in the tool window. Copilot in IntelliJ gives plugins no chat, so nothing is recorded there.
   - **The app:** a **Prompt history** screen (More, Run, beside Model runs, `#/history`): the turns grouped by session, each prompt with its response, each in a `<pre>`; a filter box and a change filter; whether recording is on and why not.
6. **The local API**, read-only: `GET /api/history` (`?change=`, `?session=`, `?q=`, `?limit=`) gives the turns and whether recording is on; `GET /api/history/{id}` one record and its pair. Additive; API_VERSION 2.10.0.

## Consequences

- A team sees what was asked and answered while a change was worked on, beside what Atticus's own steps asked (ADR 0106), and finds a prompt again by its words or its change.
- The history is as private as the person's own machine: it is never committed, never sent anywhere, and an organisation or a person can turn it off.
- What is recorded is exact about where it came from: Claude Code's prompts and replies in a metarepo, and `@atticus` in VS Code. Copilot's own chats, and anything typed in IntelliJ, are not, and every surface that shows the history says so.

## Addendum (2026-10-23): a change only when it is said

A record's change was the one change id its text named, matched by word. A short id (`fix`) then tagged prompts about anything. A record's change is now only an explicit one: the change the surface passes (`atticus history add --change <id>`, when it is one of the metarepo's changes), or else the branch `change/<id>`, or else none.
