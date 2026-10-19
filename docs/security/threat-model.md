# Atticus threat model

What Atticus protects, who might attack it, how, and what stops them. Written for the security review at an install; kept up to date with each ADR that changes a boundary. Last reviewed for 1.0 (M5).

## What Atticus is, from a security view

Atticus is a command line and a local web app that run on a person's own machine, against a Git metarepo they cloned. It reads code repositories (base clones and worktrees), documents dropped into `inputs/`, and optional read-only wiki adapters. It writes files in the metarepo and, only with a person's approval each time, to shared systems through adapters (pull requests on the Git host, work items, service-desk requests, notifications). AI steps run in the person's own assistant (hand-off) or, if the organisation allows it, through a model gateway or headless Claude Code.

It has no server of its own, no database of its own beyond a local SQLite index rebuilt from files, no accounts and no telemetry (telemetry is off and has no endpoint).

## Assets

| Asset                                                    | Why it matters                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Source code in the base clones and worktrees             | The organisation's code; must not leave the machine through Atticus                   |
| The catalog, changes and org pack in the metarepo        | Architecture and plans; shared through Git with the organisation's own access control |
| Documents in `inputs/`                                   | May hold partner specs and internal designs                                           |
| Credentials for the Git host, trackers and model gateway | Held by the OS credential manager, Git's helper or the plugins; never by Atticus      |
| The session token of `atticus ui`                        | Lets a caller act as the person through the local API                                 |
| The integrity of what reaches shared systems             | A PR, work item or request filed in the person's name                                 |
| The person's machine                                     | Atticus runs code (git, OpenSpec, builds in task worktrees, allow-listed executors)   |

## Trust boundaries

1. **Browser ↔ local server.** The app talks to `atticus ui` on 127.0.0.1.
2. **Atticus ↔ files it reads.** Code, documents, wiki pages and diagrams are data from many authors.
3. **Atticus ↔ AI.** Prompts and context packs go to an assistant or model; answers come back.
4. **Atticus ↔ shared systems.** Writes through adapters.
5. **Atticus ↔ executors.** Local automation tools an org pack allow-lists (ADR 0033).
6. **Atticus ↔ the person helping with support.** The support bundle.

## Threats and controls (STRIDE)

| #   | Threat                                                                                   | Boundary | Control                                                                                                                                                                                                                                                                                                                       | Where                                             |
| --- | ---------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| S1  | Another website in the person's browser calls the local API (CSRF, DNS rebinding)        | 1        | Listens on 127.0.0.1 only (refuses any other host); every API call needs the per-start session token in `X-Atticus-Token`; the `Host` header must be this server and `Origin`, when sent, must be too (stops DNS rebinding); no CORS headers, so other origins can't read responses; the token reaches only same-origin pages | `packages/server/src/server.ts`, ADR 0015         |
| S2  | Another local user or process uses the API                                               | 1        | The token is new on every start and printed only to the person's terminal and the page served to 127.0.0.1; compared in constant time. A process running as the same user can read it: that user is already trusted with their own files                                                                                      | ADR 0015                                          |
| S3  | Someone approves a write as somebody else                                                | 4        | Approvals come only from ownership (org pack approvals, group mappings, CODEOWNERS), never from the view a person picks; separation of duties in the org pack (an author can't approve their design); approvals on hand-off PRs happen in the Git host under its own login                                                    | ADR 0044, C6 roles                                |
| T1  | A document, wiki page or code comment carries instructions for the AI (prompt injection) | 2, 3     | Ingested content is wrapped as data in every context pack; the defences scan flags instruction-like text and quarantines high-risk files to triage; agents carry the safety rules; AI output is a draft a person reviews, and the critic's rule checks run on it                                                              | ADR 0042, `packages/ai/src/defences.ts`           |
| T2  | A crafted file attacks a reader (zip bomb, path traversal, huge XML)                     | 2        | The in-house ZIP reader caps every entry and the total whatever the header claims and never writes entries to disk; readers are pure parsers with size caps; scans read files only, with no network and no AI                                                                                                                 | `packages/ingestors/src/zip.ts`, CLAUDE.md rule 4 |
| T3  | A document overrides a fact verified from code                                           | 2        | Every fact keeps its provenance and confidence; facts from documents are `inferred` at most (only a published spec is `verified`); a conflict with code becomes a triage item for a person; code wins until a person decides                                                                                                  | ADR 0004, ADR 0026, `packages/intake`             |
| T4  | A file is left half-written by a crash, or two writers race                              | —        | Whole-file writes (temporary file and rename); one scan at a time per metarepo; an interrupted scan is reported and redone                                                                                                                                                                                                    | ADR 0050                                          |
| T5  | An older Atticus rewrites files a newer one wrote                                        | —        | The metarepo stamp; an older Atticus refuses to upgrade and doctor marks it FAIL                                                                                                                                                                                                                                              | ADR 0051                                          |
| R1  | Nobody can tell who approved a write                                                     | 4        | Every adapter write carries an `Approval` (who, when, what); manual steps record who did them; hand-off PRs and their approvals live in the Git host; run records keep the context manifest hash                                                                                                                              | C4 adapters, ADR 0032                             |
| I1  | Code or documents leave the machine                                                      | 2, 3     | Scans and the index never call the network; the only paths out are the adapters and AI steps the org pack configures; context packs carry only what a step needs, with a manifest; `ai: off` or `text-only` stops all or image AI; the catalog site hides systems not visible to everyone                                     | ADR 0046, `packages/site`                         |
| I2  | A secret is written to the org pack, a log or a support bundle                           | 6        | The org pack refuses secret-looking keys; logs record flag names, never values, and are redacted (credentials in URLs, bearer tokens, key=value secrets, opaque keys, home folder, user name); the support bundle holds counts not names, and a README asking the person to read it before it leaves                          | C6, ADR 0050                                      |
| I3  | `doctor` prints a proxy password                                                         | —        | Doctor reports whether a variable is set, never its value                                                                                                                                                                                                                                                                     | ADR 0049                                          |
| I4  | The person's view, log or locks are committed and shared                                 | —        | `.atticus/.gitignore` keeps `me.yaml`, `logs/`, `locks/` and `backups/` out of Git                                                                                                                                                                                                                                            | ADR 0050                                          |
| D1  | A request or file exhausts memory                                                        | 1, 2     | Request bodies capped; readers capped per file; the index rebuilds from files                                                                                                                                                                                                                                                 | `packages/server`, readers                        |
| E1  | AI pushes to a protected branch or deploys                                               | 3        | Task runs work in their own worktree on `task/…` branches; Atticus never pushes to a protected branch and has no deploy step; autonomy levels capped per repo in the org pack                                                                                                                                                 | CLAUDE.md rule 6, ADR 0036                        |
| E2  | An executor or plugin does more than it should                                           | 5        | Executors are off until the org pack allow-lists them; each write needs approval; no credentials are passed to them; they run on the person's machine with the person's rights                                                                                                                                                | ADR 0033                                          |
| E3  | A shell injection through a file name or branch                                          | —        | Git and OpenSpec run with `execFile` (no shell); branch names and ids are validated (`RecordId`, `GitRef`)                                                                                                                                                                                                                    | `packages/workspace`                              |
| E4  | Atticus is pointed at live systems                                                       | —        | Atticus never connects to live databases, consoles or monitoring; incident mode reads the last scan only. This is not configurable                                                                                                                                                                                            | CLAUDE.md rule 6                                  |

## Rules that are not configurable

A person approves every write to shared systems. AI never pushes to protected branches or deploys. Every fact keeps its provenance, and a document never overrides a fact verified from code. Atticus never connects to live databases, consoles or monitoring. Constitution rules can't be waived. Ingested content is data, never instructions.

## What the organisation is trusted with

- The machine and its user account (Atticus runs with the person's rights, like their editor).
- Git hosting and its access control for the metarepo and code repos.
- The assistant or model gateway it approves, and that gateway's data handling.
- Plugins and executors it installs and allow-lists.

## Residual risks, accepted

- A process running as the same user can read the session token and the files Atticus can. This is the same trust as the person's editor and Git.
- Redaction is pattern-based: an unusual secret format could reach the local log. The log stays on the machine, and the support bundle asks for a read before it leaves.
- Prompt injection is reduced, not removed: AI output is always a draft a person reviews, and nothing it writes reaches a shared system without approval.

## Checks that keep this true

- `packages/server/test`: loopback only, token required, Host and Origin checks (API and live events), hardening headers on every response (`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy` and `-Opener-Policy: same-origin`, no CORS), the body cap and JSON only, static path traversal, and request reports that never carry the query.
- `packages/ai/test` and the red-team suite (`atticus defences scan`): instruction-like text in packs.
- `packages/core/test/log-and-fs.test.ts`, `packages/cli/test/support.test.ts`: redaction and what the bundle holds.
- `pnpm denylist`: no client names in the repository.
- `pnpm licences` and the SBOM (ADR 0052): what ships, and under which licences.
