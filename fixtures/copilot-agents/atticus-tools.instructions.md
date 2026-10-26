---
description: "Atticus's own commands and MCP tools: what to run to gather a step's context and to check an answer, instead of writing a check of your own."
applyTo: "**"
---

# Atticus's commands and tools

Atticus checks every answer deterministically. Use its commands and its MCP tools; don't write a check of your own.

- `atticus next` says which step is next and the command that takes it. `atticus next --all` says the whole list.
- `atticus assistant-files --check` says whether this workspace is an Atticus metarepo and whether its assistant files are up to date. Run it before a step and stop on what it says.
- `atticus map <repo> --estimate` says the folder to read, the commit and the facts file to write. `atticus verify <repo>` checks every fact against the line it cites and writes `<repo>.rejected.jsonl` for the ones that don't hold.
- `atticus repo describe <repo> --drafted "<sentence>" --cites <file>:<line>` hands a repo's description over as a draft for a person to confirm.
- A stage command with `--handoff` prints the prompt file, the result file and the two commands that finish the step: `atticus handoff done <run>`, then the same command with `--resume <run>`.
- `atticus task context <change> <task> --markdown` loads a task's context, so nothing is pasted into the chat.
- `atticus findings <change>` lists the critic's findings and their state. `atticus questions list --state open` lists the questions waiting on a person.
- The read-only `atticus` MCP server offers the same reading: `next_step`, `waiting_on_you`, `task_context`, `findings`, `open_questions`, `knowledge_items`, `knowledge_ask`, `change_status`, `change_needs`, and `grep`, `files`, `outline` and `show_code` over the code. Register it from `.vscode/mcp.json`.

The only network call an Atticus step makes is to the model provider the organisation configured. Don't reach anywhere else.
