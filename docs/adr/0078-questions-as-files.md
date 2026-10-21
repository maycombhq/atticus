# 0078. Questions and answers as files, and the questions API (C6, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), ADR 0075 (scan settings per repo)

## Context

The plan (`docs/plan/revamp.md`, principles 4 and 5, section 4.1 step 5) says a scan stops at ambiguity as a question to a person, with options, evidence and a proposed scope (this repo, or every repo of its type). The person answers in the app, the answer is written to a file, the app shows the command to rerun, the rerun reads the answer, and an answered question is not asked again.

Nothing holds such a question today. `OwnerQuestion` (C1) is a catalog record for knowledge gaps, sent to a named owner over a channel; `Unresolved` (C1) is a name a reader couldn't resolve. Both are generated catalog, rebuilt on every scan. An answer is a person's words and must survive every rescan, so it can't live in the catalog.

## Decision

**A question file (C6), `questions/<id>.yaml` in the metarepo** (`.atticus/questions/` in a repo adopted in place), schema `Question`, schema version 1:

```yaml
schemaVersion: 1
id: q-a4a06bcb15a5
askedBy:
  {
    step: scan-survey,
    command: atticus scan survey forge-notes,
    run: run-20261021120000-0001,
    at: "2026-10-21T12:00:00.000Z",
  }
repo: forge-notes
question: Is docs/ a generated playground or part of the product?
options:
  - { label: Generated, means: nobody edits it, changes: the scan leaves docs/ out }
  - { label: Product, means: it ships, changes: the scan reads docs/ }
evidence: ["docs/playground.js:1"]
scope: { level: repo, id: forge-notes } # proposed; or { level: repo-type, id: <type> }
state: open # open | answered | retired
rerun: atticus scan survey forge-notes --force
answer: # when answered
  option: 1 # or text: "the person's own words"
  by: priya.nair # the Git user (ADR 0073)
  at: "2026-10-21T12:30:00.000Z"
  scope: { level: repo, id: forge-notes } # the scope the person confirmed
  skill: org-pack/process/skills/<type>/SKILL.md # repo-type answers only
```

- **The id is a fingerprint** of the step, the repo, the question (case and spacing aside) and the evidence (in any order): `q-` and 12 hex of its SHA-256. A rerun that asks the same thing gets the same id, so it isn't written twice and an answer is never lost.
- **A step raises questions inside its own YAML answer** as a `questions` list (`QuestionDraft`: question, options, evidence, scope, and `repoType` for a repo-type scope). Atticus checks every evidence line exists in the repo before writing anything; a failure is handed back like any other check (ADR 0075). `atticus scan survey` is the first step that does this; its settings file never holds the questions.
- **The rerun reads the answers.** The survey puts this repo's answered questions (question, evidence, answer and who gave it) and its still-open ones in the prompt, as data, and tells the assistant to follow the answers and ask none of them again.
- **Answering writes the file.** `atticus questions answer <id> --option <n> | --text "..." [--scope repo|repo-type] [--type <repo type>]` and `POST /api/questions/{id}/answer` call the same core function: it records the option or words, the Git user, the time and the confirmed scope, and returns the rerun command. A repo-type answer is also written as a line under `## Answers` in the type's skill file, `org-pack/process/skills/<type>/SKILL.md`, when that file exists; the path is kept in the answer either way. Both files go through a pull request like any metarepo change.
- **The questions API (C4, API 2.1.0):** `GET /api/questions[?state=]`, `GET /api/questions/{id}`, `POST /api/questions/{id}/answer`. The server never runs the step; it returns the command.
- **The app** gets a Questions page (Know group): the open questions, one question with its options, evidence and scope, a form to answer, and the command to run next.

`OwnerQuestion` and `Unresolved` are unchanged for now; `atticus questions` with no subcommand still lists the knowledge gaps and their owner questions. Folding them into the question file (plan section 5, C1 row) is a later change with its own migration.

## Consequences

- C6 gains one optional folder; C4 gains three calls (2.0.0 → 2.1.0, additive). No existing file or call changes, so no migration.
- Repo types (plan Phase 2a, I10) are built separately. Until they land, `repoTypeSkillRel` in `packages/core/src/questions.ts` points at `process/skills/<type>/SKILL.md` (marked TODO for the merge) and the CLI says when the file isn't there yet.
- `retired` is in the schema but no command sets it yet; a person edits the file. The loop's end rule (plan principle 4) will set it when a question no longer applies.
- Tests use the mock runtime and temporary metarepos; no test calls a model or the network.
