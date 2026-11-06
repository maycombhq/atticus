# 0173. Unattended Copilot runs started from the app, shown live

- Status: accepted (pending review by the product owner)
- Date: 2026-11-06
- Builds on: ADR 0015 (jobs), 0119 (live events), 0161 (`atticus map --all`), 0171 (Copilot through its Agent Client Protocol); amends build-status B1 ("the app runs no commands")
- Contracts: C4 (local API) gains `/api/copilot-runs` and two live events, additive (local API 2.52.0)

## Context

With `copilot-acp` allowed, `atticus map --all` reads an estate in fresh Copilot sessions with no pasting, but only from a terminal. People work in the app (and in VS Code and IntelliJ, which host it): they see a repo is stale or has gaps and want to read it from there. B1 said the app writes files and runs no commands, so a button for this would break it, and a button that starts something long and then goes quiet is worse than no button.

## Decision

1. **The app may start one kind of command: an unattended Copilot run**, after the person says yes to a dialog that names the repos, the kind of read (stale, gaps, whole, one repo), the model and what a session may do (read the code, write the repo's facts, run `atticus verify`). Only when runtime.yaml allows `copilot-acp`; otherwise the app says how to read through Copilot Chat instead, as before. One run at a time per metarepo; a second start is refused (409) naming the run under way.
2. **The run is `atticus map --all`'s own code, in the app's server process** (`mapAllCommand` with the `copilot-acp` runner), not a shell. It keeps the same safety: each session may only read, write its own facts and run `atticus`, and a session never starts another.
3. **Progress is structured, and the logs are kept by session.** `map --all` reports what it does as events (the plan, each session's start and end, each verify's counts); the server keeps the run's state in memory (repos done of N, the session under way, facts kept and rejected, tokens so far) and its log lines split into tabs: the run's own, then one per session. `POST /api/copilot-runs` starts it; `GET /api/copilot-runs/current` gives the state and the logs (so a reload, or VS Code and IntelliJ opening the app later, picks up where it is); `POST /api/copilot-runs/{id}/stop` stops it, as Ctrl+C does: the session under way is cancelled and the next run carries on from there. Live events `copilot-run.state` and `copilot-run.lines` keep the page current.
4. **The app shows it.** A progress strip under the top bar while a run is under way (repo n of N, the session, Stop), and a collapsible Console at the foot of the app: one tab for the run on top, one per session, follow-the-end on by default, search, and copy. Neither goes quiet: a failed start, a refusal, a stop and the end are each said.

## Consequences

- The terminal and the app run the same reading; a run started in one is not seen by the other while it runs (the app's run lives in the server), but both resume from the same `map --all` state file.
- The app's server must be able to start the Copilot language server: the same `copilotAcp.command` the terminal uses.
- B1 now reads: the app writes files after a yes and runs no commands, except an unattended Copilot run after a yes.
