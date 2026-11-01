# 0140. A change warns on guessed links, questions come in the order a change needs them, and each goes to its owner

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0073 (no roles; the person is the Git user), 0078 (questions as files), 0088 (hosts asked), 0124 (facts the assistant writes; addenda F2, Part 4 and A-callers), 0135 (how a link was joined), 0012 (C6 org-pack schemas), 0024 (the local API, C4)

## Context

The join guesses when nobody names a call's target: an Interface it made by path or by a host's first label is `inferred` and flagged with a guess (`joined-by-path`, `joined-by-label`, or J0's and J1's `joined-by-platform-setting`, `joined-by-folder-name`, `joined-despite-conflict`, ADR 0124 addendum J-guess) (F2). A call whose target nobody knows is asked as a question (`facts-targets`, the estate join's `estate-targets`, `scan-hosts`). A repo's read can be stale (its facts were read at an older commit than its checkout) or incomplete (facts rejected, not verified, files unread); Map › Trust says so. None of this reached the critic: a change could design against a guessed link, an unanswered link question or a stale read, and a map error became a design error nobody saw.

Questions were listed oldest first. A person with forty open questions answered a lone `/ping` before the one a change in flight waited on, or the one whose single answer joins a dozen calls.

Every question carries its repo, and every repo in `repos.manifest.yaml` names its `owner` team, but nothing said who a question was for, and nobody could list only their own. Nothing in the org pack said who is on a team: `roles.yaml` is deprecated (ADR 0073) and maps directory groups to roles, not people to teams.

## Decision

### 1. The critic says when a change rests on a map error (P4)

The constitution gains `constitution.change-links-known` (question `true`, lens `architecture`, severity `risk`, never waived), with the built-in check `change-links-known`. For every call the change plans (the hops in `interfaces.md`, and the touched catalog Interfaces without a row):

- **A guessed link.** Its Interface is `inferred` and flagged `joined-by-path` or `joined-by-label`: a knowledge gap asking the caller's owner "Does portal-bff's POST /transfers go to ledger-api? The map joined them by path: nothing in portal-bff's code names ledger-api." A link a person, a name, a repo or a host made (`joined-by-answer`, `-name`, `-repo`, `-host`) asks nothing, nor does an Interface `inferred` for any other reason.
- **An open link question.** An open question of a link step (`facts-targets`, `estate-targets`, `scan-hosts`) about the caller's repo asks about this call: one of the call facts on the lines it cites (a group's every call, Q1; a hosts question's every call to its host) has the Interface's line, or the hop's method and path (placeholders aside). A knowledge gap whose question is the open question's own words, whose fix is the command that answers it, and whose evidence cites the question's file (`source: manual`, `path: questions/<id>.yaml`).
- **A stale or incomplete read.** A repo the change's calls start or end in, or that the footprint names, whose read is `stale` or `incomplete` (below): one issue per repo, at risk, saying why and the command that reads it again (`atticus map <repo>` then `verify --write`, or `atticus verify <repo>` when nobody has verified it). A repo with no facts and no verifier's report is left to the checks that ask about what the catalog doesn't know: the readers alone mapped it, or nothing did.

The read comes from `repoReadOf` (core, files only): the facts file, the verifier's report beside it and the checkout's HEAD from its `.git` files (`headFromFiles`, moved from the Trust API to core). `stale`: the facts' commit is not the checkout's. `incomplete`: no verifier's report, facts rejected, facts not verified, or files the report counts as unread. The critic loads the reads and the open link questions before its checks run (`CriticContext.estate`, optional: a plugin's context without it runs the guessed-link part only).

It is a new rule, but it says only what the files show. Severity `risk`, not `blocking`: the person answering the question or reading the repo again is the fix, not a waiver. Precedent: A-callers added `constitution.route-callers-known` the same way, as data in `constitution.yaml` with no schema change. C3's schemas are unchanged.

### 2. Questions in the order a change needs them (Q3)

`atticus questions list`, `atticus next` and the app's Questions page order questions by:

1. **What a change in flight rests on** (a change not released, archived or in post-release review): its own questions (filed under its id) and the questions the newest round of each of its gates cites as evidence (the `change-links-known` findings above), unless a person set the finding aside (dismissed, waived, applied).
2. **How many calls the answer joins**: a targets question's call facts on the lines it cites (a group's question counts all its calls, Q1), a hosts question's every call to its host in any repo; with no facts to count from, one per cited line, and one for a host. A question that joins no call (a survey's, a stage's) comes after.
3. As before, oldest first.

So a lone `/ping` comes last among the link questions. `questionWeights` and `orderQuestions` in core; files only.

### 3. Each question goes to its owner (Q4)

A question's owner is the team its repo manifest names (`owner`), with the name `roles.yaml` gives it. A change's own questions, and a repo no manifest lists, have no owner, and say so ("no repos.manifest.yaml lists forge-docs, so no team owns it"). `atticus questions list` prints `Owner:` under each; `--mine` (the person is the Git user, `--by` someone else, as `atticus questions answer` finds them) lists only the questions of the teams the person is on, and says when they are on none. The app's Questions page has the same filter (_Everyone's_ / _My teams'_).

`roles.yaml` goes to **version 2** with one optional field, `teams`: `{ id, name?, people: [Git handles] }`. The rest of the file stays deprecated (ADR 0073); `teams` is the only part read. A version-1 file reads as it is; `teams` in one is refused with "teams needs schemaVersion 2: run atticus upgrade". `atticus upgrade` gains `roles-v2`, which changes the number only. Words, not permissions: a team decides what is listed, never who may read or answer.

### 4. The local API (C4 2.33.0)

`GET /api/questions` lists in the order above and adds `about` (by question id: `restsOn`, `joins`, `owner` as `{ team, name? }` or `{ none }`) and, with `mine=true`, `me` (the person's handle and teams). Additive only.

## Consequences

- A change that rests on a guessed link, an open link question or a stale read says so at its gate, with the question or command that settles it; the person decides, the gate isn't blocked.
- A change's critic findings now feed the order questions are asked in; a question a change waits on is at the top of `atticus next` and the Questions page.
- A team that wants `--mine` writes who is on it in `roles.yaml`; without it, every question still names its owner team.
- Not done: the read plan's parts (A-ledger) are not read for "incomplete" (the verifier's unread files cover the same ground once the facts are verified); a change's own questions have no team owner, though a change names its people in `owners`; the VS Code Questions view keeps its order from the API but has no _My teams'_ toggle.

**Contracts.** C3: the constitution gains one rule (data); `CriticContext` gains the optional `estate` (C4, additive for plugin checks). C6: `roles.yaml` version 2 (`teams`), with the `roles-v2` migration. C4: the local API 2.33.0, additive. C1, the facts file and the question file are unchanged.
