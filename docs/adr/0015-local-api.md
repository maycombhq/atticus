# 0015. The local API (contract C4) and its OpenAPI document

- Status: accepted
- Date: 2026-10-18

## Decision

`atticus ui` serves a local API that the UI, the CLI and assistants all use. The API only reads and writes files in the metarepo. Its contract is an OpenAPI 3.1 document generated from the zod schemas (`openApiDocument()` in `@maycombhq/core`), committed at `docs/api/openapi.json` and regenerated with `pnpm api:doc`; a test fails if the committed copy drifts.

- **Calls:** health; catalog kinds, records, record detail, graph, impact and coverage; repos and workspace sync; scan, reconcile and jobs; changes, artifacts (save with the sha256 the edit started from; 409 if the file changed meanwhile), tasks, worktrees and hand-off; AI runs (start, mark done, retry, cancel); findings and the five actions; org-pack summary.
- **Live events** on a WebSocket at `/api/events`: `file.changed`, `job.progress`, `job.done`, `index.rebuilt`, `run.changed`.
- **Errors** are RFC 9457 problem details. A gated action refused with 403 says who can act (`needs: {role, names}`).
- **Local only.** The server binds 127.0.0.1 (default port 4321) and every call needs the `X-Atticus-Token` header, a token printed at start-up and new each session, so other programs and web pages on the machine can't drive it.
- Long work (scans, syncs, reconciles) returns 202 with a job id and reports progress as events.

## Consequences

The server (M4) and the UI build against a fixed, validated contract, and every screen action has a CLI or assistant equivalent.
