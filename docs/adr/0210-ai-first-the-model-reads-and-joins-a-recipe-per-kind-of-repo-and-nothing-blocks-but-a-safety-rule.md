# 0210. AI first: the model reads and joins, a recipe per kind of repo, and nothing blocks but a safety rule

- Status: accepted (2026-11-24, by the owner: "plan the AI first approach … no more deterministic scanners … efficient and non blocking like the ease of OpenSpec"; the plan, `docs/plan/ai-first.md`, approved with "Start")
- Date: 2026-11-24
- Release: 2.0.0-beta.33
- Amends: `CLAUDE.md` hard rule 4 ("no scanner is generated": a recipe written by the model is data run by one engine, part 2); ADR 0176 and ADR 0208 (a reading rule may carry a recipe, and a recipe is proven like a learned rule); ADR 0178 (Match with Copilot's pairing runs inside Apply, part 4); ADR 0197 (four of the build's refusals become listed items, part 3)
- Supersedes: the deterministic readers as a path to the map (ADR 0074 already made them a cross-check only; part 6 turns them off and then removes them)
- Contracts: C6 reading rules go to schema version 3 (a rule's optional `extract`), with a migration; C5 `runtime.yaml` gains two optional keys (`apply.pair`, `budget`); C4 gains optional fields on the answers named in parts 3 to 5 and a minor version; the facts file (ADR 0124) is unchanged: a recipe's fact is `by: reader`, which it already allows; C1 is unchanged

## Context

Two days on an estate of 41 repos with beta.31 and beta.32: each step tried met a refusal or an
arrow the join couldn't draw, and each was answered with more code. About 458,000 lines of
source; 24,187 of them deterministic readers (`packages/extractors`), 5,424 the estate join
(`packages/core/src/facts-join*.ts`), 11,722 the verifier. The verifier is why a person can
trust what a model wrote; the readers and the join are where the misses and the blocks were.

Item 0 of the plan tested the idea before this ADR (`docs/plan/ai-first.md`, "Item 0's
results"): a strong and a small model each paired every request of a gateway proxy whose targets
name servers, not hosts, in front of two modules on one path (`fixtures/gateway-shape`), with
the hostless request left unpaired; a recipe a model wrote from one module read the other
exactly once its misses were given back; and a model checking a recipe's output cost three times
a full read and still missed facts.

## Decision

### 1. The model reads and the model joins

An arrow is a claim like any fact: this call reaches that entry, citing a line on both sides and
each line its decision rests on. The verifier checks every cited line. The join stays as a free
first pass; what it leaves loose goes to the model (part 4). It is deleted when the model's
pairing scores at least as well on the public estates and the fixtures.

### 2. A recipe per kind of repo, written by the model

A reading rule (ADR 0176) may carry an `extract`: what a small engine in core reads without a
model.

```yaml
- key: camel-rest-entries
  rule: Each verb element under a <rest> block is an entry; its path is contextPath + rest path + uri.
  files: ["src/main/resources/OSGI-INF/blueprint/*.xml"]
  extract:
    fact: entry
    pattern: '<(?<verb>get|post|put|delete|patch)(?: uri="(?<uri>[^"]*)")?'
    scopes:
      - { name: context, pattern: 'contextPath="(?<context>[^"]*)"' }
      - { name: rest, pattern: '<rest path="(?<rest>[^"]*)"' }
    fields: { method: "{verb}", path: "{context}{rest}{uri}" }
```

- **One engine, no generated code.** `pattern` is matched line by line; a scope's value is the
  nearest line above that matches; a `yaml: leaves` extract reads each leaf key. Nothing else.
- **Every part of a value is a cited capture.** A field template holds only `{group}`
  references and the separators `/ . : - _`; a scope used is cited in the fact's `with`. The
  verifier checks each part on its line. (Item 0: both models' first recipes passed every line
  check with wrong paths built from literals; this rule catches all four.)
- **A recipe is proven before it reads.** It is active once its output equals the verified
  facts a model read for two repos of the type it wasn't written from (ADR 0208's proof, with
  `reproduced` naming those repos). Otherwise it stays a draft, saying which facts differ.
- **Recipe first, model on request.** A repo whose type has an active recipe is read by it
  alone. The model reads a repo when its type has none, when a person asks, or when the join's
  misses name it; the end of that read writes or corrects the type's recipe. The files no rule
  matched are counted and shown. (Item 0: a model checking a recipe's output cost three times a
  read.)

### 3. Nothing blocks but a safety rule

| Today's refusal (ADR 0197)             | From this release                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-upgraded`                         | The upgrade runs inside the write, in its undo                                                                                                                                         |
| `hand-edits`                           | The write goes ahead and leaves each edited file as it is; the edits are listed on every write until a person keeps them (`atticus catalog edits --curate`) or discards them           |
| `large-removals`                       | A fact a new read leaves out is kept while its cited line still holds, and listed; it goes when its line no longer does, or a person removes it. Removals are listed. No count to type |
| `unexplained-removals`                 | Stays: a record removed with no cause is a fault of the build, reported as one                                                                                                         |
| A fact field or kind no Atticus writes | The fact is read without it, and the field is listed                                                                                                                                   |
| `nothing-read`, `empty`                | Stay: they guard against a read that failed                                                                                                                                            |
| `newer-atticus`                        | Stays: this Atticus can't read the files                                                                                                                                               |
| A `build.json` that doesn't read       | Stays: there is nothing to keep                                                                                                                                                        |

`--allow-removals` goes. `--discard-edits` stays, now only to discard listed edits on purpose. One undo takes a write back, as before; an upgrade run inside a write is its own undo step, said so.

The change path's stops are listed in part 7: each stays as a safety rule or becomes an open
item on the change.

### 4. The model pairs what the join left loose, inside Apply

After a write, each call the join left loose goes to the model with the entries of the repos the
estate names as candidates (by host, server name or route). A pairing whose every cited line
holds is drawn as the AI's (ADR 0178), and a person can move it. Stored per commit: a call is
paired again only when a file its claim cites changes. With AI off, a runtime that may not
decide (`decideIn`), or the budget spent, the calls stay listed and the Apply ends normally.
`runtime.yaml`: `apply.pair: true|false` (default true where AI is allowed).

### 5. A budget, said before it is spent

`runtime.yaml`: `budget: { per: run|day|month, sessions?: n, tokens?: n }`, whichever the
provider bills. Every run that calls a model says first how many sessions and tokens it plans,
and checks that its result can be written (no lock, the facts read, no upgrade owed) before its
first request. A run that would pass the budget asks, or in an unattended run stops before it
starts. A read sends its files in as few sessions as the model's limit allows.

### 6. The deterministic readers off, then gone

`atticus framework`, `dialect` and `onboard` say the readers are off by default and how to turn
them on. When the suites hold with them off, `packages/extractors` is deleted, after repo-type
detection (`scanner/src/repo-types.ts`) moves out of it. C2 (dialect rules) goes with them: its
files are read as reading rules where they carry a pattern, and the rest are listed.

### 7. The change path

A sweep of every stop from a request to an archive (2026-11-24, `packages/changes`, `planner`,
`naysayer`, `knowledge`, `taskrun`, `release`, `initiatives`, `openspec-adapter` and their
commands) found 58. Each is one of three things, and is treated so:

| Kind                        | Count | From this release                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A safety rule (hard rule 6) | 15    | Stays: a person's approval of every hand-off, sync merge, return, push, task PR, release PR, ADO write and manual-host step; none in an assistant's session; protected and default branches never pushed; only a change's own PR approves its gate; a document never accepted over a verified fact; constitution rules never waived |
| A gate                      | 17    | Becomes an open item on the change. A hand-off goes ahead with them, and its PR lists them under "Open items" for the person who approves it on the Git host: that approval is the gate. Each is still shown where it arose, and `atticus change status` lists them all                                                             |
| An error                    | 26    | Stays, and says its one fix: input Atticus can't use (a malformed requirements row, a missing brief, no change of that id, a patch that doesn't apply, an unsupported OpenSpec, a build that fails after its fix rounds). Not a gate: there is nothing to go ahead with                                                             |

The 17 gates: a later stage waits for an earlier one with a blocking finding; open questions on
a stage or a hand-off; a drafting finding repeated three drafts; a stage's acceptable findings
waiting for a waiver; an assistant's "not relevant" proposal waiting for a person; a checking
round past its limit; a person's own edit failing the checks (`--force` goes); open blocking
findings and gaps at a hand-off (`checkFindings`, `packages/changes/src/lifecycle.ts`); a
platform's mandatory gate with no critic round; `maxAuthorRounds` used up; a rule marked
`waivable: false`; the quick path's "In the code" table and acceptance criteria; OpenSpec
validation's warnings (its errors stay errors); a task held by `(after …)`; a task branch with
commits its change branch lacks; a release PR stale or not merged at go/no-go; post-release
findings and unticked tasks at archive.

Kept besides: a step that would overwrite files a person wrote still asks for `--force` (a
copy is kept); an AI answer still can't write outside its repo, in `.git` or over the
constitution; and an assistant still can't waive, accept or dismiss for a person (ADR 0115).

One gap the sweep found is closed: outside an ACP session, an assistant's terminal could pass
`--approve` to `change handoff` and `task run`, recorded under the Git user. The check finding
actions already make (`packages/naysayer/src/act.ts`) is applied to every `--approve`.

### 8. One command, and smaller releases

`atticus sync` reads what changed (recipe, then model), verifies, writes, pairs and says what is
open; the app's Apply button and both editors run it, and every other map command keeps working
off the first page of help. The size check (`scripts/check-size-budget.mjs`) becomes: no more
lines of source than the last release.

## What does not change

Every fact cites file, line, value and quote, and the verifier checks it. Results are stored per
commit. Hard rule 6, whole. C1. A learned rule's proof and its fail-closed checks (ADR 0208).

## Consequences

- A model call is the norm for a new kind of repo and for an arrow the join can't draw; a budget
  bounds it, and a proven recipe makes the next repo of that kind free.
- A recipe can be wrong the same way everywhere; proof against two other repos' model reads, and
  values made only of cited parts, are what stand against that. The public estates and the
  fixtures are scored in CI.
- Four refusals become lists a person works when they choose. A read that failed still refuses.
