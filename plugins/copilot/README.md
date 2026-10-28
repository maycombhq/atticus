# Atticus for GitHub Copilot's agent mode

Atticus's AI steps, run by Copilot's agent mode (ADR 0121 addendum of 2026-10-26). Version 2.0.0-beta.7.

`@atticus` in the chat answers; agent mode edits files and runs commands, which is what Atticus's
steps want: the agent writes the facts file or the stage answer where Atticus expects it, runs the
Atticus command that checks it, and iterates on what the check hands back.

## What is here

| File | What Copilot does with it |
| ---- | ------------------------- |
| `.github/agents/atticus-repo-reader.agent.md` | A custom agent: Read a repo into facts, each citing its file and line, and loop on atticus verify until every fact passes. A **read** step. |
| `.github/agents/atticus-verifier.agent.md` | A custom agent: Check what was recorded about a repo against its code: the facts with atticus verify, an older scan with atticus scan verify. A **read** step. |
| `.github/agents/atticus-repo-describer.agent.md` | A custom agent: Draft the one sentence that says what a repo is for, cited from its code, for a person to confirm. A **read** step. |
| `.github/agents/atticus-stage-drafter.agent.md` | A custom agent: Draft a change's stage (feature, architecture, stories, the fast path or the first draft) and loop on Atticus's checks and the critic. A **draft** step. |
| `.github/agents/atticus-task-runner.agent.md` | A custom agent: Implement one task of a change in its own worktree, from the context Atticus loads, with a test per acceptance criterion. A **draft** step. |
| `.github/agents/atticus-knowledge-reader.agent.md` | A custom agent: Read the wikis into knowledge items, search them, answer from them only, and say what a change needs from the organisation. A **knowledge** step. |
| `.github/instructions/atticus-rules.instructions.md` | The rules every step keeps, applied to every file. |
| `.github/instructions/atticus-tools.instructions.md` | Atticus's commands and MCP tools, applied to every file. |
| `.vscode/mcp.json` | Registers the read-only `atticus mcp` server, so the agent's checks are Atticus's. |

## Setting it up

1. Install Atticus's command line so `atticus` is on your PATH (its install guide says how, offline).
2. Copy `.github/agents/`, `.github/instructions/` and `.vscode/mcp.json` into your metarepo, or run
   `atticus assistant-files` there, which writes the same per-organisation files from the org pack.
3. Reload VS Code, open Copilot Chat, choose **Agent**, and pick the agent for the step you are taking.
   **Atticus: Run the next step in Copilot's agent mode** opens it for you with the step's prompt.

In VS Code, pick the model the organisation names for the step's kind: `atticus.models.read`,
`.draft`, `.critic`, `.knowledge` or `.quick` (ADR 0121 addendum). Each agent file says its kind.

## What it does not do

- It signs nothing in and reaches nothing: the only network call a step makes is to the model
  provider the organisation configured.
- It never opens or merges a pull request, never pushes to a protected branch and never deploys.
- It never closes one of the critic's findings: an AI's claim is recorded as a proposal and the
  finding stays open until a person decides (ADR 0115 addendum, 2026-10-25).

This folder is generated: `pnpm copilot-agents` writes it from the same commands
`atticus assistant-files` renders and the Claude Code plugin comes from. Don't edit it by hand.
