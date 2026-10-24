# Contributing to Atticus

Thanks for helping. Atticus is early; the best contributions right now are bug reports, extractor and dialect test cases, and reviews of the contracts.

1. Read [CLAUDE.md](CLAUDE.md): the hard rules, definition of done and ticket loop apply to people and AI assistants alike.
2. Open an issue before large changes, especially anything touching a frozen contract (those need an ADR).
3. Fork, create a branch, write tests first, run `pnpm check`, open a PR with the template filled in.
4. Never include code, names or data from your employer or clients. Use invented examples.

By contributing you agree your contribution is licensed under the Apache License 2.0.

## Build-tool telemetry

Turborepo, the build tool, sends anonymous usage data unless told not to. Set `TURBO_TELEMETRY_DISABLED=1` in your environment (or run `pnpm exec turbo telemetry disable` once). Atticus itself, and the offline bundle, make no such call.
