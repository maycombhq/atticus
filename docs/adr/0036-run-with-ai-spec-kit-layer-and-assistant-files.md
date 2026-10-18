# 0036. Run with AI, the Spec Kit layer, assistant files and the runtime factory

- Status: accepted
- Date: 2026-10-18

## Decision

**Runtime factory.** `createRuntime` turns `runtime.yaml` (`modes`, `models`, `adapters.model`, `assistants`) into the AI runtime and refuses what the file doesn't allow with an actionable message. Model providers are plugins; with none installed it says so. Headless Claude Code runs `claude -p` in the task worktree with JSON output, no permission prompts and the data rule, behind a runner interface. `runtimeForCli` adds `--mode`, `ATTICUS_RUNTIME` and `ATTICUS_REPLAY_DIR`. CI never touches a model or the Claude CLI.

**Run with AI** runs one task of a change in its repo at plan-only, draft or PR level, in hand-off, model or headless Claude Code mode. Work happens in a task worktree on `task/<change>/<task>` cut from the change branch. Draft runs the repo's build through an injectable runner and sends failures back for up to `autonomy.maxFixRounds` rounds (default 3), every attempt recorded, then hands to a person; a passing build is committed locally. PR level needs a person's approval: it pushes the task branch and opens a PR into the change branch through the Git host adapter, never a protected or default branch, and never merges or deploys. `autonomy.capPerRepo` caps the level. Hand-off mode writes a task prompt and waits for `atticus handoff done`.

**Spec Kit layer** (ADR 0030 as built). It pins the Spec Kit 1.2.1 layout (`.specify/memory|templates|scripts`, `.specify/feature.json`, features at `specs/<task-id>`); the `feature.json` key is an assumption kept in one constant. Hand-down seeds `spec.md`, `plan.md`, `data-model.md`, `contracts/` and a requirements checklist from the change, and the repo constitution from the same rules the critic applies. The `speckit` extractor reads the structured parts on every scan as planned, inferred records with line evidence, never prose; the OpenAPI and AsyncAPI extractors skip `specs/<feature>/contracts/`, and merge keeps a record `current` when code shows it, so a plan never masks a fact. Hand-up attaches evidence, ticks the task, runs the code-and-test lens on a built-in `hand-up` gate and runs drift. The three-way drift check writes C3 findings on a built-in `drift` gate: contradictions with the approved design block, additions warn. Built-in gates are recognised by the critic's tooling whether or not `gates.yaml` lists them.

**Assistant files.** One skill source (org-pack skills, agents and `process/commands`) generates Copilot (`.github/copilot-instructions.md` section, prompts, custom agents, instructions) and Claude Code (`CLAUDE.md` section, commands, agents, skills) files for the allowed assistants only: zero-install `/atticus-*` commands in the metarepo, Spec Kit-compatible `/speckit.*` commands with templates and scripts in Spec Kit repos, `/atticus-task` in repos on the `atticus` build engine. Each file carries a header with its source and a sha-256: regeneration is idempotent and hand edits are kept unless `--force`.

**Configuration (C6, additive):** optional `runtime.yaml` `buildEngine` (`speckit` default, or `atticus`, per repo), and the `manual` adapter type (ADR 0032) for every external system except the model.

## Consequences

Every AI code change is reviewable, reproducible in tests and gated by a build and a person; a repo with no build command can't get an AI PR. Teams change assistant instructions in one place. Not yet: real model provider plugins and real assistant smoke runs (done by a person, decisions-pending items 9 and 10), drift after every scan for open changes, parsing a hand-up lens run completed in hand-off mode, and the manual adapter's instruction behaviour (planning track). Candidate additive contract: a C6 schema for `process/commands`.
