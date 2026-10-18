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

### Release and Run screens

Registered by the CLI (`uiRunRoutes` in `packages/cli/src/ui-api-run.ts`). Reads come from the metarepo's files through the libraries; writes run the command functions as the signed-in person. None of them calls an outside system.

- `GET /api/todo?change=&all=1`: manual steps (fields, instructions, what to record, what each waits for, the executors that may do it), where steps come from (each system's adapter type and open steps, exports in `inputs/`), the org pack's procedures with their allowed and set-up executors and last run.
- `GET /api/todo/{stepId}/export?format=text|csv|import`: one step for copying, as `atticus todo show --export`.
- `POST /api/todo/{stepId}/done` (`values`, or `skip` with `note`; optional `change`): `atticus todo done --by <signed-in user>`.
- `GET /api/todo/{stepId}/run?with=`: the exact inputs an executor would get and their sha-256, before any run.
- `POST /api/todo/{stepId}/run` (`with`, `inputsSha256`, `fillOnly`): `atticus todo run --approve <signed-in user> --inputs <sha>`; the click on the shown inputs is the approval.
- `GET /api/release` and `GET /api/release/{changeId}`: changes (those at go / no-go first); for one, status and blockers, release approvers from `gates.yaml`, the release hand-off, open findings, service requests filed and to file, repos with PRs and builds (`repos.yaml`), the rollout section of `design.md`, conflicts with other changes, the archive gate (`ci archive-gate`) and the change folder's files (the evidence).
- `POST /api/release/{changeId}/archive` (`rescan`): the archive gate, then `atticus change archive`. Go / no-go itself is the existing hand-off call.
- `GET /api/service-desk?change=`: snow.md's drafts matched to templates, with missing required fields and state (to file, waiting as a step for a person, filed with its number), the adapter, exports and allowed executors.
- `POST /api/service-desk/{changeId}/draft` (`force`): `atticus plan snow`. `POST /api/service-desk/{changeId}/submit`: `atticus plan submit --approve <signed-in user>` through the manual service desk, so filing from the app makes a step a person does in the desk.
- `GET /api/governance`: org-pack conformance (`atticus conformance --kind org-pack`), rule layers (constitution, org, team, refused packs), waivers, override rates (`atticus critic stats`) and separation-of-duties blockers. The catalog checks on the screen use `GET /api/search`.
- `GET /api/evals`: the AI-quality summary, eval runs, and how people resolved critic findings. `POST /api/evals/run` (`mode` mock or replay, `agents`, `runs`): `atticus eval run`; live mode is refused (it calls a real model), so it stays in the terminal.
- `GET /api/evals/defences`: `atticus defences scan` of `inputs/` and the wiki folders, plus each change's quarantine items (`review/defences/`).
- `GET /api/learning`, `POST /api/learning/start` (`lesson`), `POST /api/learning/check` (`answer`), `POST /api/learning/sandbox` (`dir`): lessons by role with progress and the current step; `atticus learn start`, `learn check` (a failed check is a 200 with `pass: false` and the hint) and `sandbox create`.
- `GET /api/settings`: runtime.yaml (modes, assistants, models, autonomy, budgets, retention), each adapter's type, the executors set up here with what the org pack allows them for, the org-pack summary and gates. `GET /api/settings/executors/check`: `atticus executors check` (pings the local executors; nothing runs).

## Consequences

The OpenAPI document (`pnpm api:doc`) carries the new calls and fields, and the C4 request schemas (`NewChangeRequest`, `HandoffRequest`, `SyncRequest`, `FindingActionRequest`, and the Release and Run bodies `StepDoneRequest`, `StepRunRequest`, `ArchiveRequest`, `DraftRequestsRequest`, `EvalRunRequest`, `StartLessonRequest`, `CheckLessonRequest`, `SandboxRequest`) are the ones the server parses. Index reads are serialised per metarepo, so calls made together on a fresh metarepo don't race the first index build. Plugins and assistants that only used the first contract are unaffected.
