# Prompt history fixtures (ADR 0110)

Invented Forge data only.

| File | What it holds |
| --- | --- |
| `2026-10.jsonl`, `2026-09.jsonl` | `.atticus/history/` as `atticus history add` writes it: two sessions in October (VS Code's `@atticus /stories`, and Claude Code's `/atticus-needs` with its response, then a prompt with no response yet), one line that isn't a record (skipped), and a September session whose response was masked |
| `claude-transcript.jsonl` | A Claude Code transcript as the `Stop` hook reads it: a prompt, a reply that ran a tool, the tool's result, and the reply's last text |

The command line's, the API's and the plugin's tests copy these into a temporary metarepo; no test writes to them.
