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

[`packages/cli/test/properties/`](packages/cli/test/properties/) holds the model-based property tests of ADR 0195 point 10 (ticket CS4), written with fast-check's `fc.commands`. Each run makes a small invented Forge estate on disk (2 to 5 repos with calls and topics between them, local git clones in a temporary folder, no network), runs a random sequence of commands against the catalog's writers (scans in full, with a repo not cloned, with a reader failing, with `--repos`; `verify --write` that succeeds or is refused; a live facts edit; an answer; curated decisions; archive, remove, rename; a hand edit; undo; upgrade; the same writer again) and checks the twelve invariants after each command, against a small model of what each repo's readers and facts last observed. Equivalence is checked at the end against a fresh build.

- **The system under test is chosen in one place**, `SYSTEM` in `system.ts`. Today it is the beta.26 writers; CS2 points it at the slot writers and `buildCatalog`.
- **Known failures** are the invariants today's writers break (`KNOWN_FAILURES` in `invariants.ts`). Each has its shrunk counterexample in `regressions/<invariant>.json`, run as `it.fails`; when a change makes one pass, its test fails until the invariant comes off the list. Never make a property weaker to make it pass.
- **`pnpm check` runs 100 sequences**; `pnpm --filter @maycombhq/cli test:properties:nightly` runs 2,000 (there is no nightly CI job yet, so it is run by hand or before a release).
- **Every run prints its seed.** A failure prints the seed, the path and the shrunk commands, and the `Replay:` line it prints (`ATTICUS_PROPERTIES_SEED`, `_PATH` and `_COMMANDS`) replays it, `ATTICUS_PROPERTIES_INVARIANTS=all` (or a comma list) checks the known failures too, `ATTICUS_PROPERTIES_RUNS=<n>` sets the count and `ATTICUS_PROPERTIES_RECORD=1` writes a failure's counterexample under `regressions/`.

## Build-tool telemetry

Turborepo, the build tool, sends anonymous usage data unless told not to. Set `TURBO_TELEMETRY_DISABLED=1` in your environment (or run `pnpm exec turbo telemetry disable` once). Atticus itself, and the offline bundle, make no such call.
