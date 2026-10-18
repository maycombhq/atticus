# Forge Spec Kit: the M3 track D fixture

Hand-written inputs and expected outputs for Run with AI, the Spec Kit layer (ADR 0030) and assistant files. It runs on top of `fixtures/forge` (org pack, repos and expected catalog) and the change `add-transfer-limit` in `fixtures/forge-change`, which it never changes.

| Folder | What it holds |
| --- | --- |
| `org-pack/` | Files laid over the Forge pack: `runtime.yaml` (model mode with the mock provider, the build engine with forge-portal-bff on `atticus`, a manual service desk), `repos.manifest.yaml` with build commands, the `task-runner` agent, a second skill (`forge-migrations`) and a draft one that is never generated (`portal-copy`), an org command (`process/commands/explain-pattern.md`) and a code-and-test checklist |
| `expected/handdown/forge-ledger/` | What hand-down of task 1.2 must write in forge-ledger: `specs/1.2/` (spec.md, plan.md, data-model.md, contracts/ledger-api.yaml, checklists/requirements.md) and `.specify/feature.json` |
| `drift/forge-ledger/specs/1.2/` | A seeded drifting plan: Northwind called directly instead of through the gateway, a new fraud-scorer system, a limit-refused event to audit-svc, a narrowed column type, a new velocity_cache table and an endpoint the design lacks |
| `expected/drift.yaml` | The six drift findings the seeded plan must raise (two blocking contradictions, four warnings) |

Rules: the expected files are hand-written; never regenerate them from Atticus's output. The extractor's own golden fixture is in `packages/extractors/test/fixtures/speckit/`.
