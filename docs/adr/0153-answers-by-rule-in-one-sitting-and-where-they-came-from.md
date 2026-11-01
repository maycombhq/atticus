# 0153. Answers by rule, in one sitting, to the change's people, and where they came from

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0078 (questions as files), 0088 (which repo answers on a host), 0117 (judgments; question schema version 2), 0134 (a shared host and each repo's base path), 0140 (questions routed to their owner), 0144 (answers the assistant proposes), 0124 addendum C-join, Q1 (a group's question), O1 (an outside system from a hosts question), 0024 (the local API, C4)

## Context

Questions about where calls go come in families. Forty calls to `*.payments.forge.internal`, or every call under `/forge/limits/`, go to the same place, and a person who knows that answers the same question forty times, then again for every call the next read finds. Q1 asks a group's calls once, but a group is one repo's calls with one prefix; it never reaches the next repo of the same type, and a call outside the group's words is asked again. A manifest host with `*`, or a repo's `basePath`, already answers every matching host call by rule, but only a person editing the manifest by hand gets that.

A person with twenty open questions answers them one at a time, each a command or a page visit. Most answers are a number.

A change's own questions are filed under the change's id (ADR 0089). ADR 0140 routes a question to the team that owns its repo; a change is not a repo, so its questions said "no owner", and `--mine` never listed them for the people on the change.

An answer accepted from the assistant's proposal (ADR 0144) was recorded exactly as a person's own answer: the proposal file is removed or left stale, and a reviewer reading the question file could not tell the assistant read the code and the person confirmed it.

Hosts questions asked before beta.10 have no "An outside system (new)" options (O1), and an open one is never asked again, so it never gains them.

## Decision

### 1. Answer by rule (Q2)

A target or hosts answer may carry a rule, `answer.match`: a host pattern as a manifest takes it (`*.payments.forge.internal`, `*` for any part of a label, a port when it needs one) or a path prefix (`/forge/limits/**`, or `/forge/limits`: the path and every path under it, by whole segments, a placeholder matching any one). It rides on the answer, not a new rules file: `atticus questions answer <id> --option <n> --match <pattern>`, the rule field of the Questions page's answer form, and `match` on `POST /api/questions/{id}/answer`. `answerQuestion` refuses a rule on any other question, one that isn't a host pattern or a path prefix, and on the options that name no one place (a group's "Not all to one place"; a hosts question's outside-system options and "None of these").

- **A targets answer by rule** covers every call that still has no target (no target named, no host or URL) and matches, found now or later, in each repo its scope allows: the question's own repo at `repo` scope, every repo of the type at `repo-type` scope. `targetsFromAnswers` reads every repo's targets questions for it (`ruledTargets`). A call's own answer comes first, then its group's (Q1), then a rule; of two rules, the one scoped to the repo, then the longer, then the later. A call a rule covers is not asked, and an open question whose every call a rule covers retires, naming the rule's question (`staleTargetQuestions`, `replacedBy`). "None of these" by rule binds every call it covers out of the join (F3).
- **A hosts answer by rule** reuses the manifest's own matching. A host pattern (which must cover the asked host) goes under the chosen repo's `hosts` in place of the host; a path prefix writes the host and sets the repo's `basePath` (refused when the repo gives another). The other open hosts questions the pattern covers retire, answered by it. A hosts rule is estate-wide, as the manifest is: the manifest says who answers on a host whoever calls it.

An outside system answered by rule is not offered: a profile alias is a host, not a pattern, and widening it is a change to how aliases match. It is left for a later item.

### 2. Answer in one sitting (Q6)

`atticus questions sheet [--out <file>]` writes every open question, in the order to ask them, into one YAML file (`questions-sheet.yaml` at the root by default): its id, repo, question, options in words, evidence, proposed scope, a fingerprint of what was asked (`asked`: its words, options, evidence, scope and state), an empty `answer:` and, for a target or hosts question, an empty `match:`. `atticus questions sheet --apply <file>` answers each filled entry through `answerQuestion`, as the person running it (their Git user, or `--by`), and reports each: answered, skipped (left blank, or answered or retired since) or refused (its question changed since the sheet was written, or the answer is refused as `atticus questions answer` would refuse it). A number is an option, words are the person's own; `scope:` and `type:` widen it. It exits 1 when an entry was refused. The sheet is a working file, never committed and not a contract: the question files stay the record, each written as one answer would write it.

### 3. A change's own questions go to its people (Q4)

`routeOfQuestion` (core) routes a question filed under a change's id to the people its `change.yaml` names under `owners`, every handle once (`peopleOfChange`), whatever they do on it: `{ change, people }`. A change whose `owners` names nobody still says it has no owner. `--mine` and _My teams'_ list a question when the person is on its team or is one of its change's people (`isPersonsQuestion`). `GET /api/questions`'s `about[id].owner` gains the `{ change, people }` shape.

### 4. An answer accepted from a proposal says so (Q5)

`acceptProposal` records, in the answer, `proposal`: the assistant that proposed it, when, and the lines it cited (repo, file, line, quote), each checked again when accepted. `by` stays the person who accepted it. `atticus questions show` and the Questions page say it was the assistant's proposal, confirmed by that person, with the lines.

### 5. Old hosts questions gain the outside-system options (O1 follow-up)

On the next write that asks about hosts (`atticus scan`, `atticus verify <repo> --write`, `atticus estate join`), an open hosts question without the outside-system options gains them: the same id, evidence, who asked and options it had, the two new ones placed before "None of these" so a number someone read still names the same option. An answered or retired question is never touched. The run says each question it re-asked.

### 6. The contract: question schema version 3

`answer.match` and `answer.proposal` are new optional fields of the question file (ADR 0078, C6), so the question schema goes to version 3 (`QUESTION_SCHEMA_VERSION`). Version-1 and version-2 files read as before and come back as version 3 in memory; writers write version 3. `atticus upgrade`'s `questions-v3` step (it was `questions-v2`) rewrites version-1 and version-2 files at version 3; only the version changes. The local API goes to 2.41.0, additive only: the answer's two fields in `Question`, `match` on the answer request, and the change owner in `about`. `docs/api/openapi.json` is regenerated.

## Consequences

- One answer joins every call of a family, now and later, across the repos of a type; nobody answers the same host or prefix again, and a person reads in the question file which rule decided a call.
- A rule on a hosts answer is written where a reviewer already reads hosts (the manifest), so the join's own matching, not a second matcher, decides the calls.
- Twenty questions are answered in one file and one command, each still written and reviewed as its own answer, and nobody answers a question that changed under them.
- A change's questions reach the people on it; a reviewer sees which answers were the assistant's proposals that a person confirmed.
- An older tool reading a version-3 question file refuses it as a newer version; `atticus upgrade` is how a metarepo moves.
