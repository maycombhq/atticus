# 0008. One OpenSpec adapter: the CLI, pinned, offline

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/openspec-adapter` is the only code that talks to OpenSpec. It runs OpenSpec's own CLI (the bundled `@fission-ai/openspec`, pinned to an exact version) with the current Node and `--json`, and parses each output with a loose zod schema listing only the fields Atticus uses.

- **Version.** The dependency is pinned exactly (1.14.0). Any installed version from 1.13.0 up to, not including, 2.0.0 is accepted; others are refused with a clear message. Pre-releases are never accepted. Upgrading means bumping the pin and passing the contract tests.
- **Offline.** Every run sets `DO_NOT_TRACK=1`, `OPENSPEC_TELEMETRY=0`, `OPENSPEC_NO_UPDATE_CHECK=1` and turns off shell-completion and global-config writes, colour and prompts. Atticus never causes a network call the user did not ask for.
- **Root.** OpenSpec looks upward for the nearest root. The adapter checks the root OpenSpec reports and refuses a result from any other folder.
- **Safety Atticus adds.** Ids are checked before anything runs. Archive refuses a change with unfinished tasks (OpenSpec allows it with `--yes`). Validation failures come back as a report, not an exception.
- **Assistant files.** `init` runs with `--tools none`; Atticus generates assistant files itself from one source for Copilot and Claude Code.
- **Org-flow schema.** The adapter writes the org-flow workflow schema in OpenSpec's own schema format to `openspec/schemas/org-flow/` (proposal → specs, interfaces → mappings, data → design → stories → tasks → snow) and can make it the default in `openspec/config.yaml`, keeping the file's comments.

## Why the CLI and not the library

OpenSpec's CLI and its `--json` output are its supported surface; its internal modules are not. Running the CLI also keeps OpenSpec's own behaviour (validation rules, archive merge) exactly as its users know it.

## Consequences

Contract tests run the real CLI on every CI run and pin down every field Atticus reads. An OpenSpec upgrade that changes one of them fails CI before it reaches users.
