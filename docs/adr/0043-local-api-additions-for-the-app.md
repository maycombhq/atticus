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

## Consequences

The OpenAPI document (`pnpm api:doc`) gains the new calls and fields when the app screens that use them land. Plugins and assistants that only used the first contract are unaffected.
