# Atticus

**Map a multi-repo ecosystem from its code, then run every change from idea to release, with an AI critic that argues the other side and a human approval at every gate.**

Atticus is an open-source, configurable framework for teams whose systems span many repositories, gateways, event streams and vendors. It builds on [OpenSpec](https://github.com/Fission-AI/openspec) and works with the AI assistant you already use (GitHub Copilot or Claude Code).

> **Status: early build (M0).** The catalog contracts, canonical file format, plugin SDK basics, OpenSpec adapter and workspace manager are in place. Scanning, the critic and Atticus Studio (the local UI) are being built in the stages described below. Nothing here is ready for production use yet.

## What it does

- **Catalog from code.** Parsers read code, gateway config, event configs, infrastructure, migrations and pipelines into a catalog of who calls whom, what data lives where, and how everything runs. Every fact records its source, commit and confidence.
- **Impact and reconcile.** Ask what a change to an API, table or column will break, and check architects' diagrams against what the code really does.
- **Changes across repos.** One change, many repos: ordering, a branch and PR per repo, tickets, release plan.
- **A critic with evidence.** Seven review lenses (business, architecture, story, UX, delivery, code and test, release). Findings carry evidence and a suggested fix; when Atticus lacks a fact it says so instead of passing silently.
- **Every role.** Screens for product owners, analysts, architects, developers, testers, delivery leads and more, not just an editor.
- **Configurable.** Everything organisation-specific lives in an org pack: dialects for house frameworks, change types, roles, checklists, integration patterns, templates and AI policy.
- **Adopts what you have.** Runs on top of an existing AI metarepo or OpenSpec repo without moving anything, and absorbs other teams' repos and wikis.

AI teaches and drafts; deterministic code does the repeated work. Scans never call a model.

## Repository layout

```
packages/
  core/              contracts C1 (catalog), C2 (dialects), C3 (checklists and findings), workspace files, canonical YAML, identity and branch rules
  sdk/               plugin SDK (C4): extractors, ingestors, scan runner and cache
  openspec-adapter/  the only door to OpenSpec: pinned CLI wrapper, org-flow schema, contract tests
  workspace/         base clones, change worktrees, repos files, VS Code and IntelliJ workspaces
  adapters/          work tracker, service desk, Git host, wiki, design tool, notifications; each with a mock
  ai/                AI runtime (C5): context packs, hand-off, model, mock and replay runtimes
  extractors/        built-in extractors and the dialect rule engine
  synth/             synthetic estate generator for scale tests
  cli/               the `atticus` command
  fixtures/          tests that keep the Forge fixture consistent
fixtures/forge/      an invented ecosystem with a hand-written expected catalog
docs/adr/            architecture decision records
```

## Try it

Requires Node.js 22.12 or newer and Git.

```bash
corepack enable
pnpm install
pnpm check          # deny-list, lint, typecheck, tests
node packages/cli/dist/bin.js --help
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors and AI coding assistants follow [CLAUDE.md](CLAUDE.md); [docs/build-status.md](docs/build-status.md) says what is done and what is next.

## Licence

[Apache 2.0](LICENSE). The name comes from Atticus Finch, the honest advocate in _To Kill a Mockingbird_; the project lives in the `maycombhq` organisation, after the town where he lived.
