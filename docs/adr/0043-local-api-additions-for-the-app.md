# 0043. Local API additions for the app (C4, additive)

- Status: accepted
- Date: 2026-10-18

## Context

ADR 0015 fixed the local API before the screens existed. Building the server (M4) against the screens showed calls they need that the first contract doesn't have, and request bodies that are too narrow for the forms. Every change here is additive: nothing is removed or renamed, and an M3-era client keeps working.

## Decision

- **Write calls run the CLI's own command functions.** The server package (`@maycombhq/server`) holds the transport (127.0.0.1 only, session token, origin and host checks, problem details, live events, jobs) and the read calls. The CLI registers the write calls (`uiRoutes` in `packages/cli/src/ui-api.ts`), each running the same function the terminal does: exit 0 is success, 1 a refusal returned as 422 with the command's own words, 2 a bad request (400). The screen and `atticus …` can't disagree.
- **New calls:** `GET /api/changes/{changeId}/status` (state, phase, next state, next step, risk, tests, required approvals, blockers and reasons, as `atticus change status --json`) and `POST /api/changes/{changeId}/sync` (refresh the hand-off PR from the Git host).
- **Wider bodies:** `POST /api/changes` also takes `owners` (role → people), `systems` and `template`; `POST /api/changes/{changeId}/handoff` takes `phase` optionally (default: the change's current phase) and `repo` (the metarepo, when runtime.yaml doesn't name it); `POST /api/findings/{changeId}/{findingId}/action` takes `gate` (ADR 0041 finding-gate fix).
- **Task lists** carry each task's branch (`task/<change>/<task>`).
- **Starting a run** (`POST /api/changes/{changeId}/runs`) covers task runs, the story writer and the critic; other agents start from their own screens.
- **The 422 status** is added to the documented error statuses for write calls.
- **Read-only views** for the Know to Build screens: `GET /api/view/{name}` and `GET /api/view/{name}/{id}` run one whitelisted `atticus … --json` command (coverage, questions, intake, triage, features, glossary, critic stats, conflicts, sources, reconcile; and per change, feature or initiative: findings, drift, trace, story bar, feature, initiative status) and return `{code, data, problems}`. Only commands that read files are listed. An unknown view is 404, a missing or malformed id 400, a command that printed no JSON 422.
- **`GET /api/initiatives`** lists every initiative with its status; **`GET /api/diagram/{view}`** returns a catalog view (context, container, data, event, sequence; `?focus=` for the last two) as Mermaid text; **`GET /api/search`** documents the index query call the server already had.

## Consequences

The OpenAPI document (`pnpm api:doc`) carries the new calls and fields, and the C4 request schemas (`NewChangeRequest`, `HandoffRequest`, `SyncRequest`, `FindingActionRequest`) are the ones the server parses. Plugins and assistants that only used the first contract are unaffected.
