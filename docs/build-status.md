# Build status

Where the build is, so any session (cloud or local, Claude Code or Copilot) can pick up the next ticket. Update this file in the same commit as each ticket.

## Done (M0)

| Ticket | What                                                                                                                                                                                                                                              | Where                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1–3    | Monorepo, CI on Linux and Windows, ADRs 0001–0007, deny-list, contract C1 (29 record kinds), canonical YAML, JSON Schema export, `atticus catalog validate`                                                                                       | `packages/core`, `packages/cli`, `docs/adr`                       |
| 3      | Plugin SDK basics (C4): `defineExtractor`, `runExtractor`, `memoryRepo`                                                                                                                                                                           | `packages/sdk`                                                    |
| 4      | Forge fixture ecosystem: seven repos, diagram, wiki pages, tickets, hand-written expected catalog, 13 seeded discrepancies                                                                                                                        | `fixtures/forge`, `packages/fixtures`                             |
| 5      | OpenSpec adapter (pinned CLI, contract tests, org-flow schema); `repos.manifest.yaml` and change `repos.yaml`; workspace manager (base clones, change worktrees, VS Code and IntelliJ workspaces, prune); `atticus openspec`, `atticus workspace` | `packages/openspec-adapter`, `packages/workspace`, ADRs 0008–0009 |
| 6      | Scan runner: `fsRepo` over base clones, evidence stamping, C1 validation, extractor isolation, deterministic order; commit-keyed scan cache in memory or on disk; `checkoutState`                                                                 | `packages/sdk`, `packages/workspace`, ADR 0010                    |

## Next

1. **Ticket 7: contracts C2 and C3.** Dialect rule format (how a house framework's annotations map to Endpoint, Interface and so on) and the checklist rule and finding format, including the `needs` field and the knowledge-gap finding kind. zod schemas, JSON Schema, sample files, ADR.
2. **Ticket 8: adapter mocks.** One adapter interface with a mock each for the work tracker, service desk, Git host, wiki and notifications; the mock and recorded-replay AI runtimes (C5); org-pack schemas (C6) for roles, runtime, sources, patterns, change types, gates.
3. **Remaining M0:** the local API's OpenAPI document (C4), the 300-repo synthetic generator, CI green on both platforms.
4. **M1:** OpenAPI, gateway and Spring extractors; the Forge dialect; merge and identity; scan and diff; SQLite index; draw.io ingestor; reconcile. Exit: a scan of `fixtures/forge` matches `expected/scan.yaml`, and reconcile finds d01–d06.

## How to work

Follow `CLAUDE.md`: fixtures and tests first, `pnpm check` green, one commit per ticket with the attribution lines, never commit client data.
