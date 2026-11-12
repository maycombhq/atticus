# Contributing to Atticus

Thanks for helping. Atticus is early; the best contributions right now are bug reports, extractor and dialect test cases, and reviews of the contracts.

1. Read [CLAUDE.md](CLAUDE.md): the hard rules, definition of done and ticket loop apply to people and AI assistants alike.
2. Open an issue before large changes, especially anything touching a frozen contract (those need an ADR).
3. Fork, create a branch, write tests first, run `pnpm check`, open a PR with the template filled in.
4. Never include code, names or data from your employer or clients. Use invented examples.

By contributing you agree your contribution is licensed under the Apache License 2.0.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs what `pnpm check` runs, on Linux and Windows, split into jobs that run at once on each system: `lint` (deny-list, lint, typecheck), `test` (every package's tests in shards: on Windows three of packages, two of the CLI's test files and four of the role journeys; on Linux, about twice as fast, two, one and three) and `speed` (m5-exit and the CLI's `test:speed`, alone on their runner). The `check` job waits for them all: it is the one result to require.

- **A new package or journey needs no CI edit.** [`.github/scripts/ci-shard.mjs`](.github/scripts/ci-shard.mjs) shares out every package with a test script, every CLI test file and every journey file from what is in the repo; its measured times only balance the shards.
- **Builds are kept between runs.** Turbo's cache of the build outputs is saved with `actions/cache`, and a package is built again only when turbo's hash of its inputs changed: its own files, `tsconfig.base.json`, `scripts/` and the packages it depends on ([`turbo.json`](turbo.json)). A build that reads anything else must list it there.
- **Test results are kept only for the same tree.** Tests read files across the repo that turbo can't see, so a result is reused only on a re-run or for a commit whose tree was tested before; any change runs every test again.

## The catalog's property tests

[`packages/cli/test/properties/`](packages/cli/test/properties/) holds the model-based property tests of ADR 0195 point 10 (ticket CS4), written with fast-check's `fc.commands`. Each run makes a small invented Forge estate on disk (2 to 4 repos with calls and topics between them, some with ten more routes so a removal can be under the 10% limit; local git clones in a temporary folder, no network), sometimes first a beta.26 metarepo and its upgrade, and runs a random sequence of commands against the catalog's writers: scans (in full, with a repo not cloned, with a reader failing, cancelled, reading nothing, with `--repos`), `verify --write` that succeeds or is refused, a live facts edit, answers, curated decisions (suppress, assert, alias) added and taken away, archive, remove, hand edits made curated or discarded, confirmations with the count a refusal listed and with another, rename (and one whose new slots fail), `catalog build`, `undo <n>`, `prune`, a crash part way through a write, upgrade and the same command again. After each command it checks the twelve invariants, the large-removal guard and completeness (a command the model expects to succeed does, and the catalog holds the endpoints, components and arrows the model says the build makes) against a small model of what each repo's readers and facts last observed. Equivalence is checked at the end against a fresh build of the final slots.

- **The system under test is chosen in one place**, `SYSTEM` in `system.ts`, behind the interface in `seam.ts`, which says what a system must do. Today it is the beta.26 writers; CS2 points it at the slot writers and `buildCatalog`. `mutants.ts` holds systems that are wrong on purpose (one refuses everything, one writes nothing), and the test checks the oracle fails them.
- **Known failures** are the invariants today's writers break (`KNOWN_FAILURES` in `invariants.ts`, and `FAILS_TODAY` in `examples.ts` for the hand-written examples). Each has its shrunk counterexample in `regressions/<invariant>.json`, which must fail with that invariant; when a change makes one pass, its test fails and says which lists to take it off. Never make a property weaker to make it pass.
- **`pnpm check` runs 100 sequences of up to 10 commands**; the nightly workflow (`.github/workflows/properties-nightly.yml`, `pnpm --filter @maycombhq/cli test:properties:nightly`) runs 2,000 of up to 20. A run of 100 or more fails when a command never acted in it.
- **Every run prints its seed.** A failure prints the `Replay:` line that runs it again (`ATTICUS_PROPERTIES_SEED`, `_PATH`, `_COMMANDS`, `_RUNS`, `_MAX_COMMANDS`, `_INVARIANTS` and a `-t` filter), and the shrunk commands and estate. `ATTICUS_PROPERTIES_INVARIANTS=all` (or a comma list) checks the known failures too, `ATTICUS_PROPERTIES_RUNS=<n>` and `_MAX_COMMANDS=<n>` set the count and the length, `ATTICUS_PROPERTIES_RECORD=1` writes a failure's counterexample under `regressions/`, and `ATTICUS_PROPERTIES_VERBOSE=1` prints how often each command ran and acted and its time.

## Build-tool telemetry

Turborepo, the build tool, sends anonymous usage data unless told not to. Set `TURBO_TELEMETRY_DISABLED=1` in your environment (or run `pnpm exec turbo telemetry disable` once). Atticus itself, and the offline bundle, make no such call.
