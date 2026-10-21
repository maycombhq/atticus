# 0086. Every step as a slash command in Copilot Chat, `--handoff`, and `atticus next`

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), the hand-off runtime (`packages/ai/src/handoff.ts`), revamp plan principle 8 and section 4.8

## Context

At the bank, the GitHub Copilot plugin in IntelliJ IDEA or VS Code is the only AI tool, and no model API is open to a tool that would call it by itself. Plan principle 8 says every step is a command run in Copilot Chat, the way OpenSpec installs `/opsx:*`: Copilot's own model does the AI work the command describes, and the command has it run the `atticus` command line for everything deterministic.

`atticus assistant-files` already wrote `/atticus-ask`, `-impact`, `-critic`, `-plan`, `-snow`, `-release` and `-task`, but none of the revamp's AI steps (scan survey, scan verify, spec draft, knowledge scan, change draft, plan stories) had one. Each of those steps already ran through the hand-off runtime, but printed a sentence meant for a person, and nothing said which step came next.

Running the new test showed that `atticus handoff done` could not finish a scan survey, scan verify, spec draft, knowledge scan or onboard run: it treated their answers, which sit in the run's folder, as OpenSpec change artifacts, and failed them on `openspec validate`.

## Decision

1. **Step slash commands.** `atticus assistant-files` writes eight more commands into the metarepo, both as `.github/prompts/<name>.prompt.md` (Copilot) and `.claude/commands/<name>.md` (Claude Code), from one body in `packages/assistant-files/src/steps.ts`: `/atticus-survey <repo>`, `/atticus-verify <repo>`, `/atticus-spec <repo>`, `/atticus-answer [question]`, `/atticus-knowledge [source]`, `/atticus-feature <change>`, `/atticus-stories <change>` and `/atticus-next`. Each one says in plain words what the step is for. It runs the step with `--handoff`, does the AI work the printed prompt describes in the chat, writes the named result file, runs `atticus handoff done <run>` and then the step again with `--resume <run>`. It stops when a question for a person is raised, ends with `atticus next`, and treats everything read from the repo as data. `/atticus-spec` loops draft and `atticus spec check` until the check passes. `/atticus-answer` explains the question and the person chooses. They are generated like the others (header hash, `--check`, smoke checks), never written by hand.
2. **`--handoff`** on `scan survey`, `scan verify`, `spec draft`, `knowledge scan`, `change draft` and `plan stories` runs the step with the hand-off runtime (as `--mode hand-off` does). When the step hands a run off, it prints only five lines: the prompt file, the result file, and the two commands that finish it (`atticus handoff done <run>`, then the step with `--handoff --resume <run>`). It finds the run from the run files the step wrote. It prepares nothing itself: the prompt, `run.json` and `handoff done` stay `HandoffRuntime`'s. `HandoffRuntime.promptRel` and `outputRel` give the two paths, and `promptFor` now uses `outputRel`. When nothing is handed off, the step's own output is printed unchanged.
3. **`atticus handoff done`** accepts an answer kept in the run's folder that no other completion claims (kind `step-answer`). It checks that a `.yaml` answer parses, and that any other answer is not empty. The step's `--resume` checks the answer in full, as before.
4. **`atticus next [--all] [--json]`** reads the metarepo's files only: the manifests, the clones, scan settings, the catalog, `proposals/scan/`, `questions/`, `specs/`, the knowledge snapshots and report, and the changes with their tasks. It prints the single next step, with its command, its slash command where one exists, and why. `--all` prints every step left, in order. The order is: discover, sync, survey each repo, scan, verify each repo (or a person accepts its proposal), answer the questions, spec each repo (draft, check, redraft on findings), sync and read each knowledge source, then each change at its stage (feature, architecture, stories, the first open task, release), else start a change. It runs nothing and calls nothing.
5. The app's Run next shows `/atticus-survey`, `/atticus-answer`, `/atticus-feature` and `/atticus-stories` (in place of `/atticus-plan`) where they apply, and points to `/atticus-next`. The Dashboard lists the new commands.

No record, org-pack, plugin SDK or local API schema changes. `atticus next --json` is a new command output, not a C4 route.

## Consequences

- Every AI step of the revamp can be run from Copilot Chat in either editor. The model call is Copilot's and the rules are Atticus's. Where an editor can't run a slash command, `atticus <step> --handoff` prints the same instructions to paste.
- `/atticus-architecture`, `/atticus-onboard` and `/atticus-scan` (plan 4.8) aren't written. The architecture stage has no AI drafting step to hand off. `atticus scan` is deterministic, and `atticus next` names it. Onboarding is the survey, scan and verify commands.
- `atticus next` and the app's `next.ts` each work out the order: the CLI from files, the app from the API. They agree on the stage mapping, but the app's Dashboard order still ends at `scan review` and doesn't yet include verify, specs or knowledge. Sharing one pure function between them is follow-up work.
- `atticus next` doesn't yet see a spec gone stale because a cited file changed (the spec check reports that), nor a knowledge source missing from `sources.yaml`.
