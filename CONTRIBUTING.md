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

## Build-tool telemetry

Turborepo, the build tool, sends anonymous usage data unless told not to. Set `TURBO_TELEMETRY_DISABLED=1` in your environment (or run `pnpm exec turbo telemetry disable` once). Atticus itself, and the offline bundle, make no such call.
