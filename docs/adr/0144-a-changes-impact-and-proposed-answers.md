# 0144. A change's impact, as designed, and answers the assistant proposes for a person to confirm

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0130 (a vendor's two versions compared, and what they reach), 0124 (facts the assistant writes; addenda B-arch, F2), 0125 (required fields), 0135 (how a link was joined), 0140 (guessed links at the critic, questions routed to their owner), 0078 (questions as files), 0073 (the person is the Git user), 0024 (the local API, C4)

## Context

`atticus intake impact` says what a vendor's newer spec reaches in the estate: the gateway routes, the service calls through them and who calls those, with every step cited (ADR 0130). Our own changes had nothing like it. The architecture stage works out each target flow's breaking contract changes and their consumers (`breakingChanges`, B-arch) to check the draft lists them, and design.md says them in a sentence each, but nobody could see, in one place, who a change breaks, which fields stop crossing, which gateway routes need updating, and which team owns each part.

A consumer the map knows from a guessed link (an Interface `inferred` and flagged `joined-by-path` or `joined-by-label`) is as likely to be a false break as a real one. Counting it with the sure breaks overstates the change; leaving it out hides a call that may be real.

Open questions wait on a person, and many are answered by reading code and config a person would have to open anyway: which host is production, which repo answers a call. The assistant can read that code, but a question is a person's to answer (ADR 0078): an answer the assistant writes itself would be a guess recorded as a decision.

## Decision

### 1. A change's impact (V1)

`changeImpact` (planner, `stages/impact.ts`; pure) takes a change's target flows, the estate (catalog and specs, as the stages read it) and each repo's owner. For every breaking change `breakingChanges` finds (an entry or a table), it lists:

- **Who calls or uses it today.** An entry's callers are the `from` of each Interface to it (by its Endpoint, or its component, method and path), the components of spec flows whose call-out or publish names it, and the caller its own trigger names; a table's are its readers and writers and the spec flows that store into it. The flow's own component is left out. Each caller has its Interfaces, spec flows, gateway routes and cited caller lines.
- **Whether it breaks.** `breaks` when one of its links was read from code, named by a person, a name, a repo or a host, or a spec flow says it calls it; `may-break` with `guessed: joined-by-path | joined-by-label` when every link it has is an `inferred` Interface with a guess flag and no spec flow names it. The counts (`breaks`, `mayBreak`) never mix them. The view names the critic's `constitution.change-links-known` (ADR 0140), which already asks the caller's owner to confirm a guessed link; it asks nothing itself.
- **The fields that stop crossing.** `BreakingChange.fields` (optional, additive): returned or read today and not once the change is in, every field the entry reads and returns when the entry step or the flow goes, and the request fields its callers must now send (ADR 0125).
- **The gateway routes to update.** Each GatewayRoute an Interface of a caller goes through (`route`), with its proxy, base path, the repo its config is in and the callers through it.
- **Each with its owner.** A repo's team is its manifest's `owner`, with the name roles.yaml version 2 gives it (`ownerOfQuestion`, ADR 0140); a repo no manifest lists, or a component with no repo, says why no team owns it. `owners` lists each team to involve with its repos, teams first.

It is computed from the catalog, not by walking the facts join as `vendorImpact` does: a change's entries are catalog Endpoints, and the guessed-link flags the critic reads are on catalog Interfaces, so the same records give the same answer at the gate and in this view. The walk further up the chain (who calls the callers) is not done here; the critic and the stages read only direct consumers too.

Surfaces: `atticus change impact <change> [--json]`, and **What this change breaks** on the change's Architecture tab (`GET /api/changes/{changeId}/impact`). A change with no target flows says to run its architecture stage. Files only; no model call.

### 2. Answers the assistant proposes (Q5)

A new step, `/atticus-propose [question id]` (assistant-files `propose.ts`, in every assistant's step files and the Claude Code plugin), has the assistant read the code and config behind each open question and write a proposed answer beside it, never in it:

- **Where.** `proposals/questions/<question id>.yaml` (under `.atticus/` in a repo adopted in place), the proposals folder that already holds drafts for a person to review. The question file and its format are unchanged, so this needs no contract change, no question schema version and no `atticus upgrade` step. The proposal's own shape is `QuestionProposal` (core, version 1): `answer` (`option` or `text`), `why`, `cites` (each `repo?`, `file`, `line`, `quote`, at least one), `by` (the assistant) and `at`.
- **Checked before it is shown.** `checkProposal` (core, files only, deterministic): the option is one the question has; each citation's repo is the question's or one a repo manifest lists (a valid record id, never a path), and has a checkout here (`workspace/<repo>/`); only a change's own question cites the metarepo, and never Atticus's own folders there (proposals, questions, facts, knowledge, judgments, runs), so a proposal can't rest on itself or on another AI draft; the cited file, with links followed (`realpath`), is still under that checkout or metarepo, and a refused citation's problem never says what the file holds; the line is there; the quoted words are on it (spacing, curly quotes and case aside, `quotedIn`). `atticus questions proposed [--json]` lists every proposal with what fails, and exits 1 while one fails: the step loops on it as `/atticus-map` loops on `verify`. A proposal for a question no longer open is stale and said so.
- **Shown only when it holds.** `atticus questions list` and `show` print a checked proposal under its question ("Proposed by claude-code (not answered yet)", each cited line, and the command that accepts it); one that fails is never shown as a proposal, only (by `show` and `proposed`) as its problems. `GET /api/questions` gives it as `about[id].proposal`; the Questions page shows it with its lines and **Accept as my answer**, and the person can still answer otherwise.
- **A person confirms.** `atticus questions answer <id> --accept-proposal` (alone: not with `--option` or `--text`), or Accept (`POST /api/questions/{id}/answer` with `acceptProposal: true`), checks the proposal again and writes it through `answerQuestion` as the person's answer, by them (the Git user, or the app's user), at the scope they confirm. A proposal that fails is refused, and the question stays open.

The step never runs `atticus questions answer` and never edits a question file; its text says so, and Atticus never accepts on its own. `verify` is untouched: a proposal changes no fact and no check until a person's answer is on file, and then the answer is read as any person's answer is.

### 3. The local API (C4 2.36.0)

`GET /api/changes/{changeId}/impact` (`ChangeImpact`); `QuestionList.about[id].proposal` and `AnswerQuestionRequest.acceptProposal`. Additive only.

## Consequences

- A designer sees who a change breaks, and whom to talk to, before the stories stage, from the same records the critic reads.
- A guessed link is visible as such and never inflates the count of breaks.
- An open question can arrive with its answer read from the code and its lines checked; a person confirms it with one command or click, and the answer is theirs.
- Not done: the impact doesn't walk past direct callers (the vendor impact does, from facts); a caller the draft lists that the map doesn't show is left to the stage's own `delta.consumer-unseen` note; the question file doesn't record that an answer came from a proposal (that would be a question-file change), though the proposal file stays beside it in the same pull request; VS Code's Questions view and `@atticus` don't show proposals yet.

**Contracts.** C4: the local API 2.36.0, additive. C1, C3, C6, the facts file and the question file are unchanged; the proposal file is a draft in the proposals folder, version 1, not a contract. The planner's `BreakingChange` gains an optional field (not a frozen contract).
