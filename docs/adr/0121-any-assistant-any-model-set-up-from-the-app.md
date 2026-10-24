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
- Item 2: the AI tab (`ui/src/screens/run/AiSettings.tsx`), with its routes in `cli/src/ui-api-ai.ts` and the providers' settings from `PROVIDER_SETTINGS`. Not built yet: models allowed and budgets in the form (they are kept as they are), and keys in the OS credential store (item 3, now built).
- Item 3: `@maycombhq/model-providers` `systemKeyStore` and `defaultKeyStore`; `readKey` reads the environment, then the store; `atticus secret`; the AI tab's key field. On macOS the key goes to `security -i` on stdin; on Windows it goes to PowerShell on stdin and is kept encrypted with DPAPI in `%APPDATA%\atticus\keys`; on Linux to `secret-tool` on stdin.
- Item 5, VS Code: **Atticus: Pick the model** (`vscode-model.ts` `chooseModel`, rows from `words.ts` `modelPickRows`). `atticus.model` takes `vendor/family`, a bare family (Copilot's, as before) or `atticus`. With `atticus`, the runner adds `--mode model` and doesn't ask `vscode.lm`; `atticus <step> --handoff --json` honours an explicit `--mode model` or `--mode headless-claude-code` and prints the step's end. Not built yet: IntelliJ.
- Item 6: `@maycombhq/assistant-files` `whatRunsWhere(runtime)`. It is shown on Home (`HowStepsRunLine`), in VS Code's Next view (the `runs` row), in `atticus next --json` (`runs`) and in `GET /api/settings/ai` (`runs`). The setup checklist's optional `ai` step is done once `runtime.yaml` differs from what `atticus init` writes. IntelliJ shows it through the app's Home; its own tool window doesn't yet.
- Item 4, built as a translator rather than as provider code. `ModelProviderPlugin` (C6, `core/src/schema/plugin.ts`) declares the settings, the hosts (templates filled from the settings, each part a plain name) and the auth. `adapters.model.type` accepts a plugin's id, a widening that keeps every v1 file valid. The plugin's `request` and `response` run in the scanner plugin sandbox (`sdk` `runTranslator`). `model-providers` `PluginProvider` makes the call, refuses any URL that isn't HTTPS to a named host, any URL with credentials, and any header Atticus reserves, and adds the key. The plugin never reaches the network, so the only network call stays the configured provider's (CLAUDE.md rule 4). `ai` `providerFactoryFor` finds the plugin, and the CLI registers the loader, which reads the pinned entry. `atticus plugin add vertex` ships Vertex, and `plugin test|pin` take model-provider plugins. Not built: tool calls (`chat`) from a plugin, and token refresh.
