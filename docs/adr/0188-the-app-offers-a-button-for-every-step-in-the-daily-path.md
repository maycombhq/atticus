# 0188. The app offers a button for every step in the daily path

- Status: proposed (built from the app-only coverage audit, 2026-11-09; for the product owner to accept)
- Date: 2026-11-09
- Builds on: ADR 0086 (hand-offs), ADR 0106 (Run with a model from the app), ADR 0124 (the assistant reads the repo; verify checks every fact), ADR 0183 (the app runs local steps and proposes them for review), ADR 0186 (writes to shared systems need the page's confirmation), ADR 0187 (the Console)
- Contracts: C4 (local API 3.5.0), additive only. No catalog, rule, plugin, AI runtime or org-pack schema changes.

## Context

The owner's intent is that everything can be done from the app. An audit that used only the app found that the daily path kept ending at "copy this command": reading a repo (`atticus map <repo>`, then `atticus verify <repo> --write`), the fast path's step (`atticus change small`), a correction on the canvas ("Written. Run this to redraw the map:"), the estate join, syncing the clones and the wikis, a task's context, drafting the stories again (`--force`), the history switch and cleaning up worktrees. The server could already run most of these; the pages didn't offer them. The causes were few: the app's list of AI steps missed `map <repo>` and `change small`, the generic command line showed a Run button only for AI steps, and the canvas and the Change diagram never offered Apply or Propose for review.

## Decision

1. **A person never has to type a command for a daily-path step.** Every step a person takes in the course of a day (reading and re-reading a repo, applying an answer or a correction, a stage's step, the fast path, the estate join, syncing, a task's context, Propose for review) has its button on the page that names it.
2. **A command is shown only behind an "In a terminal" disclosure.** Where the app takes the step, the command it would type is folded under "In a terminal" (or "Or in a terminal"), after the button. A command shown on its own line is one the app has no button for, and is not on the daily path.
3. **One component decides.** The page's command line (`Command`) reads the command: an AI step gets Run (Copilot or the server's model) or Prepare / Read with my assistant (a hand-off); `atticus verify <repo> [--write]` gets Apply, then Propose for review; `verify --all` gets Apply to every repo's map; `workspace sync`, `sources sync`, `estate join`, `workspace prune` and `history on|off` get their local job's button; `task context` gets "Copy task context for my assistant". A page with its own button marks its command `noRun`.
4. **The read of a repo finishes in the app.** `map <repo>` is an AI step the app prepares as a hand-off. Its Done checks the answer, takes the batch (`map <repo> --resume`), and after the last batch runs `verify <repo> --write`, so the kept facts are in the catalog and the map is drawn; what was kept and rejected is said, and the page offers the map. Nothing is written to the catalog while a fact is rejected.
5. **Edits end with Apply and Propose, not git.** A declared link, a box added, an owner set, a pairing, an Undo, a drawing on a change's diagram, a change's knowledge and a stage comment end with Apply (where the map must be redrawn) and Propose for review; the git commands are folded under "In a terminal". An answer to a read's question is applied without reading the repo again, and Propose stays on the question while its file isn't proposed.
6. **Writes stay where ADR 0186 puts them.** These buttons read repos and write the metarepo's own files or this machine's (no confirmation). Propose for review, a hand-off and every other write to a shared system still need the page's confirmation on the person's click.
7. **The daily pages are reachable from their sections.** Manual steps is a tab of Home, Release a tab of Change, Scans and Prompt history tabs of Set up, by default; Reconcile, Features and Initiatives stay under More pages.

## Consequences

- Six local API routes run what the pages named as commands (`POST /api/facts/apply-all`, `/api/estate/join`, `/api/knowledge/sources/sync`, `/api/workspace/prune`, `GET /api/changes/{changeId}/tasks/{taskId}/context`, `PUT /api/history/recording`); `/api/runs` and `/api/runs/handoff` take `map <repo>` and `change small`, and `--force` on `plan stories` only. A read's Done says which repo it put on the map (`applied`).
- The server's reasons written for the command line (`atticus next`, a refusal that says "pass --repo") are said in the app's words where the app shows them.
- A command shown with no button is a gap against this ADR: a new daily step lands with its button, or its page links to the page that has one.
