# Build status

Where the build is, so any session (cloud or local, Claude Code or Copilot) can pick up the next ticket. Update this file in the same commit as each ticket.

## Done (M0)

| Ticket | What                                                                                                                                                                                                                                                       | Where                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1–3    | Monorepo, CI on Linux and Windows, ADRs 0001–0007, deny-list, contract C1 (29 record kinds), canonical YAML, JSON Schema export, `atticus catalog validate`                                                                                                | `packages/core`, `packages/cli`, `docs/adr`                                   |
| 3      | Plugin SDK basics (C4): `defineExtractor`, `runExtractor`, `memoryRepo`                                                                                                                                                                                    | `packages/sdk`                                                                |
| 4      | Forge fixture ecosystem: seven repos, diagram, wiki pages, tickets, hand-written expected catalog, 13 seeded discrepancies                                                                                                                                 | `fixtures/forge`, `packages/fixtures`                                         |
| 5      | OpenSpec adapter (pinned CLI, contract tests, org-flow schema); `repos.manifest.yaml` and change `repos.yaml`; workspace manager (base clones, change worktrees, VS Code and IntelliJ workspaces, prune); `atticus openspec`, `atticus workspace`          | `packages/openspec-adapter`, `packages/workspace`, ADRs 0008–0009             |
| 6      | Scan runner: `fsRepo` over base clones, evidence stamping, C1 validation, extractor isolation, deterministic order; commit-keyed scan cache in memory or on disk; `checkoutState`                                                                          | `packages/sdk`, `packages/workspace`, ADR 0010                                |
| 7      | Contracts C2 (dialect rule file) and C3 (checklist packs and findings) with one shared template grammar; JSON Schema; the Forge dialect and an architecture checklist as samples in the fixture org pack                                                   | `packages/core`, `fixtures/forge/metarepo/org-pack`, ADR 0011                 |
| 8a     | Contract C6: every org-pack file as a schema, built-in defaults (13 roles, 6 change types, a gate per phase), `loadOrgPack` with cross-file checks, `atticus orgpack validate`; a full Forge org pack in the fixture                                       | `packages/core`, `packages/cli`, `fixtures/forge/metarepo/org-pack`, ADR 0012 |
| 8b     | Adapters (C4): work tracker, service desk, Git host, wiki, design tool, notifications; approval required on every write; merge gated by reviews and checks; mocks with journals, injected failures and fixture loaders; `createAdapters` from runtime.yaml | `packages/adapters`, ADR 0013                                                 |
| 8c     | Contract C5: agent definitions, context packs (data wrapping, classification, budget, manifest), the hand-off runtime with `atticus handoff done`, model runtime, mock and recorded-replay runtimes, run summaries and retention                           | `packages/ai`, `packages/core`, ADR 0014                                      |
| 9      | The local API as an OpenAPI 3.1 document generated from zod, validated, committed at `docs/api/openapi.json`; the synthetic estate generator (300 repos by default) with a scale test proving exact counts and cached rescans                              | `packages/core`, `packages/synth`, ADR 0015                                   |

## Done (M1)

| Ticket | What                                                                                                                                                                                                                                                                                                                                       | Where                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 10–11  | Built-in extractors (component, OpenAPI, Apigee, Spring, frontend, topics, SQL migrations, infrastructure) with Java, YAML, XML and SQL readers; loose ends as Unresolved records; the C2 dialect rule engine and dialect test runner; the Forge dialect passes its tests                                                                  | `packages/extractors`, ADR 0016                               |
| 12     | Merge and identity (canonical endpoint ids, interface ids, loose ends resolved through the gateway, by host and within a system, events, table access, inferred patterns, systems from the profile); the estate scan with dialect self-tests and cache; `atticus scan` and `atticus catalog diff`; catalog files written in canonical form | `packages/core`, `packages/scanner`, `packages/cli`, ADR 0017 |

## Next

1. **M0 sign-off** (Tom George): the expected catalog in `fixtures/forge/expected/` and ADRs 0001–0017; and the in-bank spikes (installs per role, Copilot features in VS Code and IntelliJ).
2. **M1:** SQLite index and query language (ticket 13); draw.io ingestor, aliases and reconcile (ticket 14); the M1 exit check (ticket 15). Exit: a scan of `fixtures/forge` matches `expected/scan.yaml` (done, apart from facts waiting for M2 intake), and reconcile finds d01–d06.

## How to work

Follow `CLAUDE.md`: fixtures and tests first, `pnpm check` green, one commit per ticket with the attribution lines, never commit client data.
