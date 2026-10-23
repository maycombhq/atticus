# 0104. A Claude Code plugin, and read-only MCP tools (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0086 (steps as slash commands), 0099 (an IntelliJ plugin), 0074 (the AI reads; every fact cites its code), 0043 (the app runs the commands' own code)

## Context

Claude Code reads the files `atticus assistant-files` writes into a metarepo (`CLAUDE.md`, `.claude/commands`, `.claude/agents`, `.claude/skills`), so the steps already run there. But each metarepo has to generate and commit them, a new Atticus version reaches no one until they run it again, Claude learns the next step only when asked, and it reads the catalog, knowledge and changes by running commands and reading files one at a time. VS Code and IntelliJ have plugins; Claude Code had none.

## Decision

1. **A Claude Code plugin, `atticus`**, committed at `plugins/atticus` and listed in this repository's marketplace (`.claude-plugin/marketplace.json`). It carries what is the same for every organisation:
   - **The slash commands:** every step (`stepCommands`) and the catalog commands (`zeroInstallCommands`, for the default `catalog/` and `openspec/` layout), byte for byte the files `assistant-files` writes. A metarepo's own `.claude/commands` win over the plugin's of the same name, so an organisation with another layout gets its own paths.
   - **A SessionStart hook:** in a metarepo (a folder with `org-pack/` or `.atticus/org-pack/`, found upward from the project), it runs `atticus next --json` and tells the session the next step and its slash command. Anywhere else it says nothing; when the command line doesn't answer, it says how to get it.
   - **The MCP server**, started through a small launcher that finds `atticus` on PATH (`atticus.cmd` on Windows) or the `bin.js` that `ATTICUS_BIN` names.
     The org pack's own agents, skills and commands stay with `assistant-files`: they differ per organisation. `pnpm claude-plugin` writes the folder from the same functions; a test fails when it is out of date. `claude plugin validate` passes for the plugin and the marketplace.
2. **`atticus mcp`: read-only tools over MCP (stdio).** next_step, catalog_query, explain, impact, knowledge_items, changes, change_status, change_needs, findings, open_questions, features, feature, triage and manual_steps. Each runs the command's own code in-process, with `--json` where it has it, and answers with what the command printed; a failed command is an error result with its message. A value that starts with `-` is refused, so an argument can never become an option. The server writes nothing: to change anything Claude runs the command or slash command, and a person approves every write to a shared system (hard rule 6). stdout carries only the protocol (initialize, ping, tools/list, tools/call; one JSON message per line).

C4 gains the MCP tool list as part of the local surface an assistant may rely on; adding a tool is additive, and renaming or removing one needs an ADR. The local HTTP API is unchanged.

## Consequences

- In Claude Code, Atticus is one install; its commands and tools update with the plugin.
- Claude starts each session in a metarepo knowing the next step, and reads the catalog and a change's needs through the same code as the app and the command line.
- The bank this is built for allows Copilot only; nothing there changes. The plugin is for teams that use Claude Code, and for working on Atticus with Claude.
