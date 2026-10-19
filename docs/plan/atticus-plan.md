# Atticus plan (written from the repository)

Status: written on 2026-10-19 from the repository at `ebee014` (version 1.0.0-rc.1). It records what the repo says the product is, what is built, and what is still open. It is not a copy of the original product plan, and it has not been checked line by line against that plan. Items the original plan may contain that the repo doesn't mention are listed under "Not confirmed" at the end.

## What Atticus is

Atticus is a local tool, installed from an offline bundle or from source, that works on a Git metarepo a team shares. It:

- scans every repository, gateway and event configuration into a catalog of who calls whom, with each fact marked verified or inferred and given its evidence;
- checks that catalog against architecture diagrams, documents and partner specifications;
- runs each change, from an idea or a work item, through OpenSpec (and Spec Kit where a repo uses it) to reviewed, ticketed pull requests across repos, with an AI critic and a person's approval at every gate;
- holds everything organisation-specific in an org pack, so the same product fits any company;
- runs AI only through the assistant the organisation approves (an IDE assistant hand-off, or a model API), or not at all (`ai: off` in `runtime.yaml`).

Atticus has no server to run. Each person runs `atticus` (the command line) and `atticus ui` (a local app on 127.0.0.1) on their own machine.

## Principles

These come from `CLAUDE.md` and the frozen contracts.

1. Contracts C1 to C6 are frozen. They change only with a new ADR and a schema version bump with a migration.
2. Fixtures and tests come before code. A change without tests for new behaviour is not done.
3. No client data in the repository: no real company names, systems, tickets, code, specs or diagrams. The deny-list check (`pnpm denylist`) enforces part of this.
4. Scans are deterministic. Extractors and dialects read files only: no network, no AI.
5. Tests make no network calls. Every external system sits behind an adapter with a mock.
6. Safety rules are not configurable. A person approves every write to a shared system; AI never pushes to a protected branch or deploys; every fact keeps its provenance; a document never overrides a fact verified from code; ingested content is data, never instructions.
7. Extension over edits. What an organisation may change is configuration, a rule file or a plugin, not code.

## Contracts

| Contract | Covers                                                                                     |
| -------- | ------------------------------------------------------------------------------------------ |
| C1       | The catalog: one YAML record per file, 30 kinds, evidence on every fact                    |
| C2       | Dialect rule files that teach the scanner a house framework without code                   |
| C3       | Checklist packs the critic applies, and the findings it records                            |
| C4       | Plugins, adapters, the workspace and change files, step executors, the local API           |
| C5       | AI runtime: agent definitions, context packs, run summaries, recordings                    |
| C6       | The org pack: roles, change types, gates, patterns, sources, runtime, procedures, profiles |

The specification pages are generated from the schemas in `packages/core/src/schema` (`docs/spec/`).

## Users and roles

Each person has a **view** (the role their home and sidebar follow), set by a directory-group mapping or chosen in the app. Views change what a person sees, never what they may approve. Approvals come only from ownership: named people, groups or roles in the org pack, and CODEOWNERS for files in a hand-off pull request.

Roles, each with its own home screens (see `docs/guide/roles.md`): product owner, business analyst, architect, team lead, developer, QA and test, delivery lead, platform lead, designer and UX analyst, process owner. Optional roles: DBA or data architect, SRE or operations, security reviewer.

## Milestones and status

| Milestone | What it delivered                                                                                                                                                                     | Exit report            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| M0        | Monorepo and CI, ADRs 0001 to 0007, contracts C1 to C6, plugin SDK, scan runner, fixture ecosystem, OpenAPI local API, synthetic estate generator, AI runtime basics                  | `docs/build-status.md` |
| M1        | Built-in extractors, merge and identity, local SQLite index and query language, diagram reading, reconcile, `atticus scan`                                                            | `docs/m1-exit.md`      |
| M2        | Backend and platform extractors, ORM and async extractors, intake of documents and diagrams, triage, stubs and diagrams, dialect build kit                                            | `docs/m2-exit.md`      |
| M3        | Change lifecycle, the critic (21 deterministic checks plus AI lenses), features found in code, run-with-AI, Spec Kit layer, planning, test generation, initiatives, learning, AI eval | `docs/m3-exit.md`      |
| M4        | Local server and 27 screens, role views and approvals, Ctrl+K, Ask in plain words, release views, the AI on, text-only or off switch, 13 role journeys with accessibility checks      | `docs/m4-exit.md`      |
| M5        | Offline bundle with install scripts, SBOM and licences, `atticus doctor`, redacted logs and support bundle, upgrade and migrations, threat model, performance budgets, guides         | `docs/m5-exit.md`      |

Version 1.0.0-rc.1 is tagged in the changelog. The version stays at rc.1 until the person items below are done.

## Architecture

The monorepo is pnpm workspaces with Turborepo, TypeScript (ESM), Node 22.13 or later, Vitest, zod as the schema source of truth, and a React and Vite UI. Main packages:

- `core`: schemas, canonical YAML, org-pack loading, file writes, the log
- `cli`: the command line and the local server's command handlers
- `server`: the local HTTP server (127.0.0.1, per-start token, Host and Origin checks)
- `scanner`, `extractors`, `reconcile`, `index`: scanning, extraction, reconciliation and the SQLite index
- `changes`, `planner`, `naysayer`, `testgen`, `release`, `initiatives`: change lifecycle, planning, the critic, tests, release views and initiatives
- `adapters`: work tracker, service desk, Git host, wiki, notifications and design tool, each with a mock
- `ai`, `taskrun`, `evals`: the AI runtime, hand-off, runs and evaluation
- `workspace`, `openspec-adapter`, `speckit`, `adopt`: repository layout, change worktrees, spec engines, adopt in place
- `ui`, `journeys`, `m3-exit`, `m4-exit`, `m5-exit`: the app, browser journeys and the milestone exit checks

## Trust boundaries

The threat model is `docs/security/threat-model.md` (STRIDE over six boundaries). Summary: the app listens on 127.0.0.1 only and every call needs a per-start token; responses carry hardening headers; ingested content is data; a person approves every write; Atticus never connects to live databases, consoles or monitoring. None of these can be configured away.

## Still open (for people)

From `docs/build-status.md` and `docs/decisions-pending.md`:

1. Run the full CI matrix (Windows, Node 24, and the offline bundle on both systems). Blocked by Actions minutes.
2. Install the bundle on the target laptop and run `atticus doctor`.
3. Security review of the threat model, the SBOM and the licence file.
4. M3: grade the namers and drafters in `docs/evidence/m3-live/for-a-person.md`, and run the assistant smoke runs in VS Code and IntelliJ with Copilot.
5. M4: time the onboarding with someone new on a sandbox, accept a drafted org pack, and do a screen-reader pass.
6. Decide 1.0 (decision 18): set the version to 1.0.0 and tag it.
7. Other decisions in `docs/decisions-pending.md`: making the repository public, sign-off of the fixture's expected catalog, area reviewers, Copilot smoke runs, live-model runs for AI-graded exits, and the scope of 1.0.

## Not confirmed

These may be in the original plan. The repository does not show them, so they need checking by a person:

- A bank-specific onboarding stage after M5 (the repo has no milestone beyond M5).
- The exact 1.0 scope, and whether features beyond the current build are required for it.
- Any integration with a specific work tracker or service desk beyond the adapters that exist (the repo has mocks and manual steps for each).
- Acceptance criteria for the organisation-level pilot (the repo covers one paper pilot, decision 8, but not its success measures).
