# Build status

Where the build is, so any session (cloud or local, Claude Code or Copilot) can pick up the next ticket. Update this file in the same commit as each ticket.

## Done (M0)

| Ticket | What                                                                                                                                                                                                                                              | Where                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1–3    | Monorepo, CI on Linux and Windows, ADRs 0001–0007, deny-list, contract C1 (29 record kinds), canonical YAML, JSON Schema export, `atticus catalog validate`                                                                                       | `packages/core`, `packages/cli`, `docs/adr`                                   |
| 3      | Plugin SDK basics (C4): `defineExtractor`, `runExtractor`, `memoryRepo`                                                                                                                                                                           | `packages/sdk`                                                                |
| 4      | Forge fixture ecosystem: seven repos, diagram, wiki pages, tickets, hand-written expected catalog, 13 seeded discrepancies                                                                                                                        | `fixtures/forge`, `packages/fixtures`                                         |
| 5      | OpenSpec adapter (pinned CLI, contract tests, org-flow schema); `repos.manifest.yaml` and change `repos.yaml`; workspace manager (base clones, change worktrees, VS Code and IntelliJ workspaces, prune); `atticus openspec`, `atticus workspace` | `packages/openspec-adapter`, `packages/workspace`, ADRs 0008–0009             |
| 6      | Scan runner: `fsRepo` over base clones, evidence stamping, C1 validation, extractor isolation, deterministic order; commit-keyed scan cache in memory or on disk; `checkoutState`                                                                 | `packages/sdk`, `packages/workspace`, ADR 0010                                |
| 7      | Contracts C2 (dialect rule file) and C3 (checklist packs and findings) with one shared template grammar; JSON Schema; the Forge dialect and an architecture checklist as samples in the fixture org pack                                          | `packages/core`, `fixtures/forge/metarepo/org-pack`, ADR 0011                 |
| 8a     | Contract C6: every org-pack file as a schema, built-in defaults (13 roles, 6 change types, a gate per phase), `loadOrgPack` with cross-file checks, `atticus orgpack validate`; a full Forge org pack in the fixture                              | `packages/core`, `packages/cli`, `fixtures/forge/metarepo/org-pack`, ADR 0012 |

## Next

1. **Ticket 8b: adapters.** One interface with a mock each for the work tracker, service desk, Git host, wiki, notifications and design tool.
2. **Ticket 8c: AI runtime (C5).** Agent definitions, context packs, the runtime interface, and the mock and recorded-replay runtimes.
3. **Remaining M0:** the local API's OpenAPI document (C4), the 300-repo synthetic generator, CI green on both platforms.
4. **M1:** OpenAPI, gateway and Spring extractors; the Forge dialect; merge and identity; scan and diff; SQLite index; draw.io ingestor; reconcile. Exit: a scan of `fixtures/forge` matches `expected/scan.yaml`, and reconcile finds d01–d06.

## How to work

Follow `CLAUDE.md`: fixtures and tests first, `pnpm check` green, one commit per ticket with the attribution lines, never commit client data.
