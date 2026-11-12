# 0171. Copilot driven unattended through its Agent Client Protocol

- Status: accepted (pending review by the product owner)
- Date: 2026-11-03
- Builds on: ADR 0014 (the AI runtime, C5), 0046 (what AI may do), 0121 and its addendum (any assistant, a model per kind of step, the run record version 4), 0144 (/atticus-propose), 0161 (the whole estate in one command), 0170 (the waiting loop agrees with verify)
- Contracts: C5 (a new runtime kind; the run record to version 5) and C6 (runtime.yaml to version 3), each with a migration

## Context

At an organisation on GitHub Copilot, every step that needs an assistant hands the person a line to paste into a new Copilot Chat: `atticus map --all` gives one line per part and waits (ADR 0161, 0170), and a forty-part repo is forty pastes. Copilot in IntelliJ and VS Code gives a plugin or a command line no API to drive it.

The GitHub Copilot language server, which the editors run, has an Agent Client Protocol mode: `npx --yes @github/copilot-language-server --help` lists `--acp  Run as Agent Client Protocol (ACP) agent`, with `--stdio` and `--node-ipc`. A person confirmed it runs on a locked-down Windows laptop where Copilot in IntelliJ is signed in. In that mode the server is an agent and the program that starts it is the client: the client opens sessions, sends prompts, is asked for files, terminals and permissions, and decides each.

## Decision

1. **A runtime kind, `copilot-acp` (C5).** Beside `headless-claude-code`. runtime.yaml (version 3) allows it in `modes.allowed` (and may make it `modes.default`), with copilot among `assistants.allowed`, and may say how to start the server:

   ```yaml
   schemaVersion: 3
   modes: { allowed: [hand-off, copilot-acp], default: copilot-acp }
   copilotAcp:
     command: npx --yes @github/copilot-language-server # the default; or the server's full path
     model: gpt-5 # optional: a model id the server offers
     maxTurns: 200 # optional: tool calls before Atticus cancels a session
     timeoutMs: 1800000 # optional: the longest one session may take
   ```

   Atticus starts `<command> --acp` (no shell, except a `.cmd` on Windows), speaks JSON-RPC over its stdio as the client, sends `initialize`, opens a **new session per step** rooted at the metarepo (`session/new` with the metarepo as `cwd` and no MCP servers), asks for the model when runtime.yaml names one the server offers, sends the step's prompt, prints short progress lines as updates arrive, and ends the server when the agent stops. A session is never reused across steps or parts: each starts with a fresh context.

2. **What a session may do is fixed in code, not configurable (rule 6).** Atticus offers the session files and a terminal (`fs` and `terminal` client capabilities) and nothing else:
   - it may read files under the metarepo and its clones (`workspace/`, or the state folder's);
   - it may write only the step's own result paths: under `facts/` for a read, under `proposals/questions/` for `/atticus-propose`, the result file of a hand-off step; never anything in `.git`;
   - it may run a terminal command only when it is `atticus` with arguments, run with this same Atticus (node and its entry script, no shell, `ATTICUS_ACP_SESSION=1` set). A command line with shell characters, any other program, and what only a person may do are refused with a message the agent sees: `questions answer`, `--approve`, `--accept`, `--accept-proposal`, `map --all` (the loop is Atticus's), `ui`, `serve`, `mcp`, and `--root`;
   - a permission it asks for is allowed **once** when the same rules allow it (an edit of its result paths, a read under the metarepo, an `atticus` command), and refused otherwise: a fetch, a delete, a move, anything else. It is never allowed "always".
     Inside a session, a step the session runs (`atticus … --handoff`) hands off to the session instead of opening another (`ATTICUS_ACP_SESSION`). The organisation's Copilot policy still applies: the server does what Copilot allows; Atticus only narrows it.

3. **Sign-in is the person's.** Atticus never calls `authenticate` and never sees a token. If the server answers that it isn't signed in, the run stops and prints what the server said (with any link and code it printed), and the person signs in themselves (in their editor's Copilot, or that link) and runs the command again. `atticus doctor` gains a check where runtime.yaml allows copilot-acp: the server is found (`<command> --version`), and whether it is signed in, from the handshake alone (`initialize` and `session/new`, no prompt: no run, no tokens).

4. **`atticus map --all` under copilot-acp.** It plans the parts as it does for Copilot Chat (`--mode copilot-acp`, or runtime.yaml's default), then for each part sends the part's line as the text Copilot would read for it: the metarepo's `.github/prompts/<command>.prompt.md` with the arguments put in (else Atticus's built-in command), after a short preamble saying no one is watching. When the session ends the part is verified as the waiting loop verifies it (ADR 0170's coverage). A part not accounted for is given once more, in a new session, with only what is left (`/atticus-map <repo> --part n --gaps`, as `r` gives it); then the run moves on, listing the part as incomplete with its command. `--max-parts` counts sessions and `--budget-tokens` the tokens the server reports (else the part's estimate). Ctrl+C cancels the session under way (`session/cancel`), saves where the estate stands and stops; the next run carries on. The state file is shared with the Copilot Chat loop, so a person can switch between the two.

5. **The other steps.** `atticus map <repo>` (a read, `--gaps`, `--force`, `--rules`) under copilot-acp runs the same loop for the one repo. `atticus questions propose [<id>]` is new: `/atticus-propose` as a command, run in one session that may write only `proposals/questions/`, followed by `atticus questions proposed`; without the mode it prints the line to paste. Every step that runs through the C5 runtime (the stages, the critic's lenses, knowledge steps, with `--mode copilot-acp` or runtime.yaml's default) runs its hand-off prompt in one session that may write only that step's result file; an agent whose `allowedRuntimes` allows hand-off allows copilot-acp (it is the hand-off, driven), and one may name copilot-acp itself. A verify-fix round is the retry of point 4.

6. **Each session is a run.** Under `.runs/<change>/<runId>/` (`map-<repo>` for a read's part): `prompt.md`, `transcript.jsonl` (every message both ways) and `run.json` with the runtime `copilot-acp`, the step's class, the model the session reported, what Atticus did for it and what it refused (as the run's tools), the tokens when the server reports them, and the assistant program: **the run record version 5** adds `assistant: {name, version, protocolVersion}`, the server's own words from `initialize`. A version 1 to 4 record reads as version 5 without it (`migrateRunSummary`).

7. **runtime.yaml version 3 (C6).** It adds `copilot-acp` to `modes` and the `copilotAcp` section. Version 1 and 2 files read as before; one that names copilot-acp (a mode or the section) is refused with "copilot-acp needs schemaVersion 3 (ADR 0171): run atticus upgrade". The upgrade step `runtime-v3` writes the number only, for such a file; any other file is left at its version, since it means the same.

8. **The protocol in one file.** No copy of the protocol's SDK or schema could be read offline, so the client is written from the public ACP specification (protocol version 1) in `packages/ai/src/acp.ts`, the only file with method and field names. What was assumed is listed below, to be checked against the real server with one smoke run.

## What to check against the real server

The method names and fields `acp.ts` assumes: `initialize` (`protocolVersion: 1`, `clientCapabilities.fs.readTextFile/writeTextFile`, `clientCapabilities.terminal`, `clientInfo`; the answer's `agentInfo.name/version`, `authMethods`); `session/new` (`cwd`, `mcpServers: []`; the answer's `sessionId` and the unstable `models.currentModelId/availableModels[].modelId`); `session/set_model`; `session/prompt` (`prompt: [{type: "text", text}]`; the answer's `stopReason` and, if any, `usage`); the `session/update` kinds `agent_message_chunk`, `tool_call` (`title`, `kind`), `plan`; `session/request_permission` (`toolCall.kind/locations/rawInput.command`, `options[].kind` `allow_once`/`reject_once`; the answer `{outcome: {outcome: "selected", optionId}}`); `fs/read_text_file`, `fs/write_text_file`, `terminal/create` (`command`, `args`, `cwd`, `outputByteLimit`), `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`; `session/cancel`; not signed in as error code -32000 (or a message about auth or sign-in). That `--acp` alone means stdio (if the server also needs `--stdio`, put it in `copilotAcp.command`). That the server's own tools ask permission before they edit or run anything, rather than writing to disk themselves; Atticus can only refuse what it is asked.

## Consequences

- A forty-part read runs without forty pastes, on the person's own Copilot seat and its policy, with each part in a fresh context.
- Atticus starts a program it didn't ship (the language server, from npx or a path runtime.yaml names); the organisation chooses it in runtime.yaml in a pull request, and doctor says which and what version.
- What a session did is on record as plainly as a headless Claude Code run: the prompt, every message, what was refused.
- Not wired here: the editors' buttons (VS Code, IntelliJ) still hand off to Copilot Chat; `atticus probe`, `/atticus-answer`, `/atticus-ask` and the other read-only slash commands have no command to drive them (they ask a person or answer in chat); the app's Set up › AI form doesn't offer the mode yet (runtime.yaml is edited by hand).

## Addendum (2.0.0-beta.21, review round 32): a session acts as no one

The list in decision 3 left out other commands that record a person's decision. A planted comment in a repo (ingested content) could get a session to run them, and Atticus ran them as the person. Now one list, `personOnlyWhy` in `packages/ai/src/person-only.ts`, holds them all: `questions answer`, `questions sheet --apply`, `verify audit` with answers (`--right`, `--wrong`, `--unsure`, `--answers`), `knowledge verify`, `correct` and `reject`, every `<group> accept`, `baseline`, `triage decide`, `finding`, `feature name` and `link`, `todo done`, `needs done` and `skip` (also under `change`), any command with `--by`, `--approve`, `--accept` or `--accept-proposal`; and (round 33) `repo add`, `repo describe` with `--description` or `--reject` (a session drafts with `--drafted`), `knowledge keep`, `alias`, and `glossary define`, `link` and `alias`; and (round 34) `--send` and `--as`, `rules activate`, `rules off` and `rules add` without `--draft`, `initiative commit` and `outcome record`. A test holds every approve flag in the command catalog to the list. `rules draft` keeps the layer file as it was before the session and puts it back if the session made a rule active, changed one or switched one off. The session's command check refuses them. The CLI itself refuses them too whenever `ATTICUS_ACP_SESSION` is set, whatever started the command. A session's command must come first (`atticus <command> …`), so a leading flag and its value can't hide what it is. No session may write a person's record under `facts/`: `<repo>.audit.yaml` or `<repo>.corrections.jsonl`. The consent dialog says so.

## Addendum (2.0.0-beta.27): what a Copilot-only metarepo hit

A person ran beta.26 with `modes: { allowed: [hand-off, copilot-acp], default: copilot-acp }` and no `adapters.model`. Four fixes, none to a contract's shape (runtime.yaml is as it was; the local API adds fields within 3.12.0):

1. **The limit.** With no `maxInput` and no probe, the app's run dialog asks for the model's limit and sends it (`maxTokens`), run as `--max-tokens`; the last value given is kept in `.atticus/map-all/limit.json` (this machine's) to fill the field next time.
2. **A part's session plans as the run did.** `atticus map <repo> --estimate`, `--part n`, `--gaps --part n` and `--rules` without `--max-tokens` take the read plan's own session size when a plan is on file at that commit, so a session never re-plans the repo at the 150K default over the run's plan.
3. **Rejections are said, and no progress is bounded.** Every read's session is told that verify moves a rejected fact to `<repo>.rejected.jsonl` with why, undoing nothing. A session that ends a turn with rejected facts is given one more turn in the same session with each reason (the AI runtime's session takes an optional `followUp`, asked when the agent ends a turn of its own accord, at most twice); the part's second session starts from them. When that one adds nothing either, the run stops the repo (a `repo.stopped` event, the run view's `problems`), says what was rejected and why, and goes on with the next repo.
4. **The assistant files are checked before the first session.** Missing or out-of-date ones are generated files in the metarepo, a local write as the facts are (ADR 0188 decision 6), so the run writes them as `atticus assistant-files` does and says so; one edited by hand only a person replaces, so the run is refused before any session, with the command that replaces it. Sessions are also told the files were checked, so an instruction file's own check doesn't end them.
