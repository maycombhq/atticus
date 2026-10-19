# Changelog

All notable changes to Atticus. Versions follow [Semantic Versioning](https://semver.org); contracts C1 to C6 change only with an ADR, a schema version and a migration (`atticus upgrade`).

## Unreleased

### Windows build and install

- `pnpm lint`, `pnpm licences`, `pnpm bundle` and `pnpm bundle:test` run on Windows: script paths come from `fileURLToPath`, the bundle imports through a file URL, and pnpm is started the way Windows needs. A new check in `pnpm lint` (`scripts/check-portable-paths.mjs`) refuses `URL.pathname` used as a file path and `import()` of a plain path.
- `install.ps1`: the `atticus.cmd` shim finds its version beside itself instead of holding a full path, so a profile folder with accented letters no longer breaks it; `-NoPath` leaves your PATH as it is.
- `pnpm bundle:test` installs into a home folder with a space and an accented letter, runs the `atticus` shim, no longer adds its throwaway folder to your PATH, and removes its temporary files when it passes. The bundle and licence check remove their `pnpm deploy` folder.
- The practice sandbox works on a machine with no Git identity (each repo gets a local one, with signing off), and its Git host is manual, so the product owner's lesson reaches Design with the command line alone: the hand-off PR steps are recorded with `atticus todo done`. Before, a fresh mock host in every command lost the PR.
- `atticus trace` no longer reports a test or plan twice when one worktree holds it with CRLF line endings (Git for Windows' `core.autocrlf`) and another with LF.
- Every package's tests run with their own temporary folder, removed when the run ends (`vitest.shared.mjs`); tests used to leave hundreds of folders behind in the system temp folder.
- CI runs the check on Linux and Windows on every push and pull request.
- The bundle leaves out `node_modules/.bin`, so a zip built on Windows holds the same files as one built on Linux.

## 1.0.0-rc.1 (2026-10-19)

The first release candidate: the whole product, built in five milestones.

### M5: ready to install

- `atticus doctor`: what this machine needs, each with a fix; first on the setup checklist and on Settings (ADR 0049).
- The local log (`.atticus/logs/`), redacted; crash messages that say where the details are; whole-file writes; one scan at a time; `atticus support bundle` (ADR 0050).
- `atticus upgrade` and `.atticus/metarepo.yaml`: migrations with backups, and an older Atticus refuses a metarepo a newer one upgraded (ADR 0051).
- The threat model; hardening headers on every response.
- The offline install bundle (`pnpm bundle`) with install scripts for Windows, macOS and Linux, checksums, a CycloneDX SBOM and third-party licences; the licence, dependency and docs checks in `pnpm lint` (ADR 0052).
- Performance budgets on 120 synthetic repos.
- Guides: install, admin, every role, troubleshooting, and the command reference.
- Fixed: the command line didn't declare `yaml`; shipped dialects were dropped outside the repository; `trace` cited tests in another task's worktree; `--port 0`.

### M4: the app

- The local API and all 27 screens in the HUD design, each with empty, loading and error states (ADRs 0015, 0043).
- A home and sidebar for each of thirteen roles, approvals from ownership only, first-run tours, guided setup and the catalog baseline (ADRs 0044, 0047).
- The command palette and Ask; system guides and the read-only catalog site; incident mode.
- Release views: deployment plan, forecast, evidence pack, release notes, outcome records and the security review draft (ADR 0045).
- AI on, text only or off (ADR 0046).
- Views across all changes, approvals waiting, the personal digest and the field-mapping grid (ADR 0048).
- The thirteen role journeys and an accessibility check of every screen in a browser.

### M3: changes from idea to release

- The change lifecycle across repos with hand-off PRs, separation of duties, risk and conflicts (ADR 0029); OpenSpec and Spec Kit as one framework (ADR 0030).
- The critic: rule layers, deterministic checks, AI lenses with evidence, rounds and gates (ADR 0034).
- Run with AI, assistant files for Copilot and Claude Code, planning, the story bar, manual adapters and executors (ADRs 0032, 0033, 0036, 0037).
- `init`, `adopt`, `absorb` and federation (ADR 0038); test generation, traceability, the CI drift check and the glossary (ADR 0039); features from code (ADR 0031); initiatives, learning, evals and defences (ADR 0042).

### M2: knowledge from documents

- Diagram and document ingestors, backend and platform extractors, intake and triage with curated decisions, knowledge sources, coverage and owner questions, stubs and diagram export, the dialect build kit (ADRs 0021 to 0028).

### M1: the catalog from code

- Built-in extractors and the dialect engine, merge and identity, the local index and query language, diagrams and reconcile (ADRs 0016 to 0020).

### M0: foundations

- The contracts C1 to C6, canonical YAML, the plugin SDK basics, the OpenSpec adapter, the workspace manager, adapters with mocks, the AI runtime and the OpenAPI document (ADRs 0001 to 0015).
