# 0121. Any assistant, any model, set up from the app (C6, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-24
- Builds on: ADR 0046 (what AI may do), 0065 (model providers), 0086 (a slash command for each step), 0090 (the chat participant), 0104 (the Claude Code plugin), 0119 (one experience on every surface)

## Context

Atticus's AI steps run in the person's own assistant (hand-off) or, where an organisation allows it, through a model provider (model mode) or headless Claude Code. Today:

- `runtime.yaml` says which assistants are allowed, but only from `copilot | claude-code`. `atticus assistant-files` writes slash commands for those two only. A team on Cursor, Gemini CLI, Windsurf, Codex or any other tool that reads `AGENTS.md` gets nothing.
- `runtime.yaml` is edited by hand. The app's Settings screen only shows it. Keys must be set as environment variables, by name.
- Providers are Anthropic, OpenAI-compatible (with Azure OpenAI) and Bedrock. There is no loader for an organisation's own provider. VS Code picks only Copilot's models, and IntelliJ can't run a step itself.

The person who chooses the AI should be able to choose it in the app. Every surface should then work with that choice, with no code change (CLAUDE.md rule 7).

## Decision

### 1. An assistant registry

`ASSISTANTS` in `@maycombhq/core` is the one list of assistants Atticus knows: `copilot`, `claude-code`, `cursor`, `gemini-cli`, `windsurf` and `agents-md`.

- `agents-md` covers Codex and any other tool that reads `AGENTS.md`.
- `runtime.yaml`'s `assistants.allowed` and `default` take any of them. This widens a closed list, so every v1 file stays valid and means the same; no schema version bump.

`@maycombhq/assistant-files` renders each assistant's own formats (`assistants.ts`):

| Assistant   | Slash commands                                 | Instructions                                 | Skills                                   | Agents                      |
| ----------- | ---------------------------------------------- | -------------------------------------------- | ---------------------------------------- | --------------------------- |
| Copilot     | `.github/prompts/*.prompt.md`                  | `.github/copilot-instructions.md` (section)  | `.github/instructions/*.instructions.md` | `.github/agents/*.agent.md` |
| Claude Code | `.claude/commands/*.md`                        | `CLAUDE.md` (section)                        | `.claude/skills/*/SKILL.md`              | `.claude/agents/*.md`       |
| Cursor      | `.cursor/commands/*.md`                        | `.cursor/rules/atticus.mdc` (always applied) | `.cursor/rules/<id>.mdc`                 | none                        |
| Gemini CLI  | `.gemini/commands/*.toml` (`{{args}}`)         | `GEMINI.md` (section)                        | none                                     | none                        |
| Windsurf    | `.windsurf/workflows/*.md`                     | `.windsurf/rules/atticus.md` (always on)     | none                                     | none                        |
| AGENTS.md   | `.atticus/prompts/*.md`, listed in `AGENTS.md` | `AGENTS.md` (section)                        | none                                     | none                        |

The command bodies are the same everywhere. Each tool's way of passing the person's words replaces `{{ARGS}}`: `$ARGUMENTS`, `${input:args}`, `{{args}}`, or "the words after the command" where a tool has no placeholder.

The one-list parity test (ADR 0119 item 3) covers every assistant. Where a tool has no slash commands of its own, `AGENTS.md` lists each `/atticus-*` command with the prompt file to follow.

Other parts that read the list:

- `doctor` looks for each allowed assistant's program (`cursor`, `gemini`, `windsurf`, `codex`).
- `atticus next` names the default assistant ("In Cursor: /atticus-feature …").
- The app shows each assistant's name.

The formats are those each tool documents in October 2026. The registry is data: a format that changes is one entry to update, and the parity test says where.

### 2. The AI tab (Set up › AI)

It shows and writes `runtime.yaml`'s AI settings:

- whether AI runs here;
- the modes allowed, and the default mode;
- the allowed assistants, and the default assistant;
- the model provider, with a form per type;
- the models allowed;
- the budgets.

Writes go through `PUT /api/settings/runtime`. It validates with the zod `Runtime` schema, refuses anything that looks like a key, writes canonical YAML, and says to commit the change in a pull request.

A **Test** button sends one small request through the runtime, with no estate content in it, and reports in words whether the provider answered.

### 3. Keys without YAML

`atticus secret set <variable>` keeps a key in the operating system's credential store: Windows Credential Manager, the macOS Keychain, or the Secret Service on Linux. It uses the system's own command, so no new dependency is added. The runtime reads a provider's `keyEnv` from the environment first, then from the store. The AI tab's "Set the key on this machine" calls it. A key is never shown, logged or written to a file.

### 4. Provider plugins from configuration

`adapters.model.type` may name a plugin in `org-pack/plugins/model-providers/<id>/`. Like scanner plugins, it is pinned by sha256 (`atticus plugin pin`) and registered with `registerModelProvider`. Vertex ships as the first one.

### 5. Every model an editor sees

- **VS Code:** "Pick the model" lists every model `vscode.lm` offers, grouped by vendor, plus "Atticus's configured model". The second runs the step in model mode through the local server.
- **IntelliJ:** "Atticus's configured model" is its first way to run a step in the IDE.

### 6. One line for what runs where

Home and the editors' Next view say which mode, assistant and model will run a step, for example "Hand-off to Copilot · model mode allowed: Anthropic". The setup checklist gains "Choose how AI runs here".

## Consequences

- A team on any of the six gets the same slash commands, checks and `next` as Copilot and Claude Code.
- Choosing the AI is a form in the app, kept in `runtime.yaml` and reviewed by pull request like every other org-pack change.
- Some tools have no hook to record prompt history; the History screen says so for them.
- At the bank, only Copilot is allowed. The registry changes nothing there unless the org pack allows more.

## Built

- Item 1.
- Item 2: the AI tab (`ui/src/screens/run/AiSettings.tsx`), with its routes in `cli/src/ui-api-ai.ts` and the providers' settings from `PROVIDER_SETTINGS`. The form also edits the models allowed and the budgets (the default and per agent); the recommended models are kept as they are. Keys in the OS credential store are item 3.
- Item 3: `@maycombhq/model-providers` `systemKeyStore` and `defaultKeyStore`; `readKey` reads the environment, then the store; `atticus secret`; the AI tab's key field. On macOS the key goes to `security -i` on stdin; on Windows it goes to PowerShell on stdin and is kept encrypted with DPAPI in `%APPDATA%\atticus\keys`; on Linux to `secret-tool` on stdin.
- Item 5, VS Code: **Atticus: Pick the model** (`vscode-model.ts` `chooseModel`, rows from `words.ts` `modelPickRows`). `atticus.model` takes `vendor/family`, a bare family (Copilot's, as before) or `atticus`. With `atticus`, the runner adds `--mode model` and doesn't ask `vscode.lm`; `atticus <step> --handoff --json` honours an explicit `--mode model` or `--mode headless-claude-code` and prints the step's end. IntelliJ: the AI step and Next step offer "Run it on Atticus's configured model" when `atticus next --json` says `modelMode` (model mode allowed, a provider set, AI not off). It runs the step with `--mode model` in a console (`Commands.withModel`), and both show the `runs` line.
- Item 6: `@maycombhq/assistant-files` `whatRunsWhere(runtime)`. It is shown on Home (`HowStepsRunLine`), in VS Code's Next view (the `runs` row), in `atticus next --json` (`runs`) and in `GET /api/settings/ai` (`runs`). The setup checklist's optional `ai` step is done once `runtime.yaml` differs from what `atticus init` writes. IntelliJ shows it through the app's Home; its own tool window doesn't yet.
- Item 4, built as a translator rather than as provider code. `ModelProviderPlugin` (C6, `core/src/schema/plugin.ts`) declares the settings, the hosts (templates filled from the settings, each part a plain name) and the auth. `adapters.model.type` accepts a plugin's id, a widening that keeps every v1 file valid. The plugin's `request` and `response` run in the scanner plugin sandbox (`sdk` `runTranslator`). `model-providers` `PluginProvider` makes the call, refuses any URL that isn't HTTPS to a named host, any URL with credentials, and any header Atticus reserves, and adds the key. The plugin never reaches the network, so the only network call stays the configured provider's (CLAUDE.md rule 4). `ai` `providerFactoryFor` finds the plugin, and the CLI registers the loader, which reads the pinned entry. `atticus plugin add vertex` ships Vertex, and `plugin test|pin` take model-provider plugins. Not built: tool calls (`chat`) from a plugin, and token refresh.

## Addendum (2026-10-26): a model per kind of step (C5, C6)

### Context

One model ran every AI step: in VS Code the one `pickModel` chose (`atticus.model`, else the chat's model, else Copilot's first), in model mode `adapters.model`'s. On Copilot Business a premium request on a big model costs a multiple of one on a small model, so running the critic's lenses and the small judgments on the model that drafts the architecture spends most of an organisation's requests where they buy least.

### Decision

1. **Five kinds of step (C5).** `STEP_CLASSES` in `@maycombhq/core`: `read`, `draft`, `critic`, `knowledge`, `quick`. Every request has one, decided in code by `@maycombhq/ai` `stepClassOf`: the tag its call site sets (`AiRequest.stepClass`), else its agent's class (`STEP_CLASS_BY_AGENT`), else `critic` for an agent that writes findings, else `draft`. Its prompt never decides it.

   | Kind      | What runs as it                                                                                                                                                                            |
   | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | read      | `atticus map` (the repo reader, its batches and the fix round for rejected facts), `scan verify` (tagged at its call site)                                                                 |
   | draft     | the feature placer, flow architect, story writers, small-change planner, change and spec drafters, scan survey and its questions, dialect and framework drafters, task runner, test writer |
   | critic    | every lens (tagged in the critic), the hand-up lens (tagged)                                                                                                                               |
   | knowledge | the knowledge reader (scan and find), the needs finder (which items apply), knowledge ask                                                                                                  |
   | quick     | the judge (every closed judgment, tagged), the context expander and reranker, the feature namer, glossary definer, template writer, explainer                                              |

   An organisation's own agent takes the class of the built-in agent with its id; a new id writing findings is a critic, any other a draft, so an unknown step never runs on less than the organisation's drafting model.

2. **runtime.yaml version 2 (C6).** `models` gains optional `read`, `draft`, `critic`, `knowledge` and `quick`. Each is a model of runtime.yaml's provider (model mode, headless Claude Code) or `vendor/family` for a model an editor offers. A kind that names none runs on the one model, as every step did. Version 1 files still read; a version 1 file that names one is refused with "run atticus upgrade". `atticus upgrade` step `runtime-v2` writes version 2 and changes nothing else (comments and order kept, `models.recommended` left as it is); `atticus init` writes version 2.

3. **The choice, in order.** In VS Code: `atticus.models.<kind>` (the person's), runtime.yaml's `models.<kind>` (the organisation's, committed in the metarepo), `atticus.model`, the chat's model, Copilot's first. In model mode and headless Claude Code: the person's setting (`ATTICUS_MODEL_<KIND>`, which both editors pass to the command line), runtime.yaml's, then `adapters.model`'s. A choice that can't be used is passed over for the next and said once: in VS Code a model `vscode.lm` doesn't offer (an admin turned it off); in model mode one `models.allowed` doesn't list, or an editor's `vendor/family`. Only the person's, the organisation's and Copilot's own are ever tried; with none left the step stops and says why. `atticus` as a kind's first choice runs the whole step in model mode; for one request of a handed-off step it is passed over, with a note.

4. **Each hand-off says its kind.** `atticus <step> --handoff --json` gives `stepClass` and `orgModel` (runtime.yaml's model for it), so a stage's draft and its lenses are answered on different models; each kind is chosen once a step. The plain hand-off prints the model the run expects, for an assistant whose model Atticus can't choose.

5. **The run record, version 4 (C5).** It keeps `stepClass` and `model`: the provider's model, the one given to headless Claude Code, or the editor's (`atticus handoff done <run> --model <vendor/family>`, which VS Code passes). Versions 1 to 3 read as 4 without them (`migrateRunSummary`). `atticus runs`, `runs show` and the app's Model runs page show both; a run kept before shows its kind from its agent and "Not recorded" for its model.

6. **What says it.** `atticus doctor` lists each kind's model and where it came from (your setting, runtime.yaml, fallback), and why a named one was passed over. `atticus next --json` gives each AI step's `stepClass` and runtime.yaml's `orgModels`; VS Code's Next view says "in VS Code: <model> for <kind> steps".

7. **Pick the model** asks "for every step, or for one kind" (each kind with what falls in it and its model now), then lists every model VS Code offers by vendor. A row shows VS Code's own note on the model when the API exposes one (Copilot's premium-request multiplier); otherwise nothing: no price is invented.

8. **IntelliJ.** Copilot in IntelliJ offers plugins no model, so the plugin can't choose one. Settings → Tools → Atticus has a field per kind. The AI step's notice and the Next step's text name the model the step expects (the setting, else runtime.yaml's) for the person to pick in Copilot's own picker; the settings reach the command line as `ATTICUS_MODEL_<KIND>`, so "Run it on Atticus's configured model" and doctor use them.

### Consequences

- At the bank: `models: { read: copilot/claude-opus-4.5, draft: copilot/claude-opus-4.5, critic: copilot/claude-sonnet-4.5, knowledge: copilot/claude-haiku-4.5, quick: copilot/claude-haiku-4.5 }` in runtime.yaml, and nobody sets anything (docs/guide/models.md).
- A stage's prompt is sized for its own kind's model; a lens prompt longer than the critic's model takes ends as "too long", as any prompt does.
- The critic's note on model families still reads `models.recommended.critic` (naysayer `criticModel`); `models.critic` names the model its lenses run on. Joining the two is left to the critic's own work.
- An editor older than this command line ignores `stepClass`; a command line older than the editor gives none, and the editor keeps one model per step and doesn't pass `--model`.

## Addendum 2 (2026-10-26): the AI-step path through Copilot in IntelliJ (C5)

### Context

Item 8 of the first addendum said Copilot in IntelliJ offers plugins no model, so the plugin names the model a step expects and the person picks it. That was right but thin: the notice only said "this is an AI step, type `/atticus-spec` in Copilot Chat", the slash command went on the clipboard only when `atticus assistant-files` had already written its prompt file, and nothing said what Atticus could and could not do for the person. The product owner, who uses IntelliJ at the bank, asked for this path to be real and provable.

### Decision

1. **What goes on the clipboard, in order of what works.** `core/Handoff.toPaste`: the step's slash command when its Copilot prompt file is written (`.github/prompts/atticus-<step>.prompt.md`); else the prompt itself, read from the file the hand-off wrote; else nothing, and the notice offers "Write the prompt files" (`atticus assistant-files`). The clipboard is set before the notice appears, so the person can paste straight away.

2. **The notice, in order, and nothing more.** `core/Handoff.notice` builds it: what to paste and where; the step's class and the model that class names, for the person to pick in Copilot's own picker (the first addendum's `ATTICUS_MODEL_<CLASS>` and `models.<class>`); how AI steps run in this metarepo (`atticus next`'s `runs`); the limit; and that `atticus` checks the answer, so nothing is taken on trust because Copilot said it.

3. **The limit, said plainly.** GitHub Copilot's IntelliJ plugin publishes no extension point, service or API a third-party plugin can call. Atticus cannot open its chat with a message in it, cannot send a prompt, cannot read a chat (so nothing typed there reaches the prompt history, ADR 0110) and cannot choose its model. The notice says exactly that. The one thing that is reachable is the IDE's own action registry, so the plugin looks up the action that opens the chat (`copilot.chat.show`) and offers "Open Copilot Chat" **when that action is registered**; when it isn't, nothing is offered and nothing is implied. When the Copilot plugin isn't installed at all, the notice says where to get it and offers the other two paths.

4. **Claude Code in a terminal, from IntelliJ.** Every AI step also offers "Run it in Claude Code in a terminal": `claude <the same slash command>` in a console in the metarepo, which the Atticus plugin for Claude Code answers (ADR 0104). The slash commands are the same words in both, so a person who moves between them types one thing. This is cheap because the console is the one the hand-off and model mode already use.

5. **So a step offers, in this order:** Copilot Chat (the clipboard, and Open Copilot Chat where the action exists), Claude Code in a terminal, Atticus's own model where `runtime.yaml` allows model mode (item 5 of the first addendum), and the hand-off on its own. `Handoff.ways` is that list and is tested.

6. **Nothing about checking changes.** The person runs the step; Copilot or Claude writes the answer where the prompt says; `atticus` checks it exactly as it does for any assistant — the facts' verifier, the draft checks, the critic. A shared write still needs a person's yes (safety rule 6).

### Consequences

- An AI step in IntelliJ is one paste and one send, with the model it wants named on screen, instead of a line of instructions.
- The guide (docs/guide/intellij.md) says what is native, what goes through Copilot or Claude Code, and the two things only VS Code does; it does not promise a Copilot integration that does not exist.
- If GitHub ever publishes an API for its IntelliJ plugin, `Copilot.kt` is the one place to change, and `Handoff.notice`'s `copilotApi` flag already has the words for it.

## Addendum 3 (2026-10-26): Atticus's steps through Copilot's agent mode

### Context

An independent architecture review (finding 3) said to prove and package the Copilot path, because
it is the one a bank's engineers will actually use and it had never been run end to end.

Until now, Copilot reached Atticus's steps two ways: the `@atticus` chat participant (ADR 0090),
which carries prompts between the command line and `vscode.lm` and answers in the chat, and the
clipboard. Both end in a chat answer. But most of Atticus's steps are not answers: the assistant
must write the facts file or the stage answer at a path Atticus named, run the command that checks
it, read what the check rejected, and go again. Copilot's **agent mode** does exactly that — it
opens files, writes them and runs commands — and Claude Code already had its own packaging for it
(ADR 0104, `plugins/atticus`). Copilot had none. `atticus assistant-files` writes
`.github/agents/*.agent.md` for the _organisation's_ agents (item 1 above), not for Atticus's own
steps.

### Decision

1. **A committed, generated artifact for Copilot, beside the Claude Code plugin.**
   `plugins/copilot/` holds the files Copilot reads, written by `pnpm copilot-agents`
   (`scripts/write-copilot-agents.mjs`, `copilotAgentFiles` in `@maycombhq/assistant-files`) from
   the same `metarepoCommands()` the Claude Code plugin comes from:

   | File                                                 | What Copilot reads it as                                                          |
   | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
   | `.github/agents/atticus-repo-reader.agent.md`        | A custom agent: a repo read into facts, looping on `atticus verify`. **read**     |
   | `.github/agents/atticus-verifier.agent.md`           | What was recorded about a repo, checked against its code. **read**                |
   | `.github/agents/atticus-repo-describer.agent.md`     | The one sentence that says what a repo is (ADR 0128), drafted and cited. **read** |
   | `.github/agents/atticus-stage-drafter.agent.md`      | The feature, architecture, stories, fast-path and first drafts. **draft**         |
   | `.github/agents/atticus-task-runner.agent.md`        | One task, in its worktree, from the context Atticus loads. **draft**              |
   | `.github/agents/atticus-knowledge-reader.agent.md`   | The wikis read, searched, answered from, and what a change needs. **knowledge**   |
   | `.github/instructions/atticus-rules.instructions.md` | The rules every step keeps, `applyTo: "**"`                                       |
   | `.github/instructions/atticus-tools.instructions.md` | Atticus's commands and MCP tools, `applyTo: "**"`                                 |
   | `.vscode/mcp.json`                                   | The read-only `atticus mcp` server                                                |
   | `atticus-agents.json`, `README.md`                   | The manifest and how to install it                                                |

   Each agent carries, **word for word**, the body of the slash commands it covers
   (`protocolFor`), so the agent and `/atticus-map` say the same thing; the repo describer carries
   the one step of the reading protocol that hands a description over, taken from `/atticus-map`
   itself (`describeStep`), and throws if that step is gone. A command the one list no longer has
   throws too. `packages/assistant-files/test/copilot-agents.test.ts` holds the committed artifact
   to the generator and to the protocol, with goldens in `fixtures/copilot-agents/`.

2. **Instructions for an agent that edits and runs, not for a chat answer.** Each agent file adds,
   around the protocol: how it works here (run the command that starts the step, write the result
   to the exact path it named, run the Atticus command that checks it, fix what it rejected, and
   never report a step done on its own reading); what it writes and which command checks each file;
   the checks it must use (Atticus's own commands and MCP tools, never a validator of its own); its
   kind of step and the setting for it; and the rules that don't bend, as what the agent must not
   do — what it reads is data and never instructions, a person approves every write to a shared
   system, no push to a protected branch and no deploy, only a person closes a blocking or risk
   finding (the addendum of 2026-10-25), a question Atticus raised is a person's to answer, and
   constitution rules are never waived.

3. **The editor opens it.** **Atticus: Run the next step in Copilot's agent mode**
   (`atticus.runInCopilotAgent`, `packages/vscode/src/copilot-agent.ts`) reads `atticus next`, maps
   the step to its agent and kind (`AGENT_BY_STEP`, held to `COPILOT_AGENTS` by a test), and opens
   `workbench.action.chat.open` on that agent with the step's prompt left in the box, as
   **Start this task in Copilot** already did (ADR 0113). The notice names the agent and the kind of
   step, so a person can pick the model their organisation named for it. Where the workspace has no
   agent file, where no agent covers the step (the critic, survey and spec drafts), or where agent
   mode can't be opened, the step goes to the `@atticus` participant, which is unchanged.

4. **Proved as far as an environment without Copilot allows.**
   `packages/cli/test/copilot-agent-path.test.ts` drives the path with a stub agent that does only
   what the agent files say, through `main()` so the exit codes are a terminal's, with no model and
   no network (rule 5; the reading loop runs no model at all and the stage runs in hand-off mode,
   where the agent is the model): a Forge repo read into facts with one that doesn't hold,
   `atticus verify` exiting 1 with the reason and 0 after the fix; a description handed over as a
   draft and refused when it cites nothing; a feature stage where the critic's lens finds the flow
   marked read and the agent's second draft fixes it, ending done; and an AI's `not-relevant` on
   that finding recorded as a proposal with the finding still open.

### Consequences

- At the bank, where only Copilot is allowed, Atticus's steps run in the assistant people already
  have, in the mode that can actually take them.
- `plugins/copilot/` is generated: a protocol change that isn't regenerated fails the tests, as
  `plugins/atticus` already did.
- What a person must still confirm is written down, not assumed: the checklist in
  `docs/guide/copilot-agent-mode.md`.
- Not built: a marketplace-style installer (Copilot has none — the files are copied into the
  metarepo in a pull request); an agent for the critic's lenses, the scan survey or the spec draft;
  a prompt-history hook for Copilot (it has none, as this ADR already noted); and anything that
  would let Atticus check which model a Copilot request really ran on.

### Limits nothing here can prove

Nothing in this repository signs in to Copilot. So it is not proven that Copilot lists and loads a
custom agent from `.github/agents/*.agent.md` in the VS Code version an organisation ships, that
agent mode obeys the instructions rather than reasoning its way to an answer, that
`.vscode/mcp.json` registers the server where policy allows MCP servers at all, that
`workbench.action.chat.open` opens agent mode on a named custom agent in that version, or that the
request runs on the model picked for the kind of step. The guide's checklist is how a person closes
that gap.
