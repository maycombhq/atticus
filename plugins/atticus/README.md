# Atticus for Claude Code

The Atticus plugin for Claude Code (ADR 0104). Install it once and it works in every metarepo:

```
/plugin marketplace add maycombhq/atticus
/plugin install atticus@maycombhq
```

It needs the `atticus` command line on your PATH (or `ATTICUS_BIN` set to its `bin.js`).

- **Slash commands.** Every Atticus step and catalog command: `/atticus-answer`, `/atticus-architecture`, `/atticus-ask`, `/atticus-attach`, `/atticus-critic`, `/atticus-draft`, `/atticus-feature`, `/atticus-find`, `/atticus-impact`, `/atticus-knowledge`, `/atticus-knowledge-ask`, `/atticus-map`, `/atticus-needs`, `/atticus-next`, `/atticus-plan`, `/atticus-probe`, `/atticus-release`, `/atticus-small`, `/atticus-snow`, `/atticus-spec`, `/atticus-stories`, `/atticus-survey`, `/atticus-task`, `/atticus-verify`. Claude does the model work; Atticus checks every answer. `/atticus-next` says which comes next.
- **The next step.** When a session starts in a metarepo, Claude is told the next step and how to take it, and how much waits on you.
- **Prompt history.** In a metarepo, each prompt you send and each reply Claude gives is kept in `.atticus/history/` on your machine (never committed), with its session and the change it is about; the app's Prompt history screen and `atticus history` show them. `atticus history off` stops it on your machine, and `history: { record: false }` in the org pack's `runtime.yaml` for everyone (ADR 0110).
- **Read-only tools.** The `atticus` MCP server: the next step; what waits on you across every change, grouped by change, with a filter; the open needs; the model runs, each with its prompt, answer and the problems handed back; the prompt history; the catalog, knowledge items, changes and their status, a change's picture (marked + new, ◇ changed, ✕ retired, as Mermaid) its estimate and whether the code does what its target flows say, a task's context (its story, criteria, step, today's code and the files to change), findings, open questions, features, triage and manual steps; and the code itself, searched by what Claude chooses (grep, files and a file's outline, ADR 0118). They read; to change anything Claude runs the command, and a person approves every write to a shared system.

The org pack's own agents, skills and commands come from `atticus assistant-files`, committed in the metarepo. A metarepo's `.claude/commands` win over the plugin's of the same name, so an organisation that changed its catalog or OpenSpec folders gets the right paths from its own files.

This folder is generated: `pnpm claude-plugin` writes it from the same commands `atticus assistant-files` renders.
