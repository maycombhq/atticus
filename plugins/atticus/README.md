# Atticus for Claude Code

The Atticus plugin for Claude Code (ADR 0104). Install it once and it works in every metarepo:

```
/plugin marketplace add maycombhq/atticus
/plugin install atticus@maycombhq
```

It needs the `atticus` command line on your PATH (or `ATTICUS_BIN` set to its `bin.js`).

- **Slash commands.** Every Atticus step: `/atticus-next`, `/atticus-survey`, `/atticus-spec`, `/atticus-knowledge`, `/atticus-find`, `/atticus-feature`, `/atticus-architecture`, `/atticus-stories`, `/atticus-needs`, `/atticus-answer`, and the catalog commands `/atticus-ask`, `/atticus-impact`, `/atticus-critic`, `/atticus-plan`, `/atticus-snow` and `/atticus-release`. Claude does the model work; Atticus checks every answer.
- **The next step.** When a session starts in a metarepo, Claude is told the next step and how to take it, and how much waits on you.
- **Read-only tools.** The `atticus` MCP server: the next step; what waits on you across every change, grouped by change, with a filter; the open needs; the model runs, each with its prompt, answer and the problems handed back; the catalog, knowledge items, changes and their status, a change's picture (marked + new, ◇ changed, ✕ retired, as Mermaid), findings, open questions, features, triage and manual steps. They read; to change anything Claude runs the command, and a person approves every write to a shared system.

The org pack's own agents, skills and commands come from `atticus assistant-files`, committed in the metarepo. A metarepo's `.claude/commands` win over the plugin's of the same name, so an organisation that changed its catalog or OpenSpec folders gets the right paths from its own files.

This folder is generated: `pnpm claude-plugin` writes it from the same commands `atticus assistant-files` renders.
