# 0210. AI first: the model reads and joins, a recipe per kind of repo, and nothing blocks but a safety rule

- Status: accepted (2026-11-24, by the owner: "plan the AI first approach … no more deterministic scanners … efficient and non blocking like the ease of OpenSpec"; the plan, `docs/plan/ai-first.md`, approved with "Start")
- Date: 2026-11-24
- Release: 2.0.0-beta.33
- Amends: `CLAUDE.md` hard rule 4 ("no scanner is generated": a recipe written by the model is data run by one engine, part 2); ADR 0176 and ADR 0208 (a reading rule may carry a recipe, and a recipe is proven like a learned rule); ADR 0178 and ADR 0181 (a pairing both of whose sides the verifier checks is drawn as the AI's inside Apply, whatever the shapes rank, part 4); ADR 0197 (four of the build's refusals become listed items, part 3)
- Supersedes: the deterministic readers as a path to the map (ADR 0074 already made them a cross-check only; part 6 turns them off by default; their removal is a later decision)
- Contracts: C6 reading rules go to schema version 3 (a rule's optional `extract`), with a migration; C5 `runtime.yaml`: `budgets` gains optional session and token limits per run, day or month, and an optional `apply.pair`; C4 gains optional fields on the answers named in parts 3 to 5 and a minor version; the facts file (ADR 0124) is unchanged: a recipe's fact is `by: reader`, which it already allows, and a fact with a field or kind this Atticus doesn't know is still kept and not read; C1 is unchanged; C2 (dialect rules) is unchanged in this release

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
pairing scores at least as well on the public estates and the fixtures (a later release).

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
      - { name: rest, pattern: '<rest path="(?<rest>[^"]*)"', end: "</rest>" }
    optional: [uri]
    fields: { method: "{verb}", path: "{context}{rest}{uri}" }
```

- **One engine, no generated code.** `pattern` is matched line by line; a scope's value is the
  nearest line above that matches; a `yaml: leaves` extract reads each leaf key. Nothing else.
- **Every part of a value is a cited capture.** A field template is `{group}` references with at
  most one separator (`/ . : - _`) between two of them, and nothing else. A group the template
  names that matched nothing drops the fact, unless the extract lists it in `optional`. A scope
  holds from its line until its `end` pattern matches, and is cited in the fact's `with`; a
  `yaml: leaves` extract cites each parent key. A value of more than six parts (the facts file's
  `with` limit) is refused when the recipe is checked. A pattern with a nested quantifier is
  refused, and lines over 2,000 characters aren't matched. (Item 0: the strong model's first
  recipe built a path from a literal, which this rule refuses. The small model's built one from
  cited parts with the rest path missing, which only the proof below catches.)
- **A recipe is proven before it reads.** It is active once its output equals the verified
  facts a model read for two repos of the type it wasn't written from: ADR 0208's proof, its
  `repos` naming those two. Reading rules go to schema version 3: a rule's `extract` is optional,
  a version 2 file reads as it did, and a refine requires a proof of an active extract, as it
  does of an active learned rule. Otherwise it stays a draft, saying which facts differ.
- **Recipe first, model on request.** A repo whose type has an active recipe is read by it
  alone. The model reads a repo when its type has none, when a person asks, or when the join's
  misses name it; the end of that read writes or corrects the type's recipe. The files no rule
  matched are counted and shown. (Item 0: a model checking a recipe's output cost three times a
  read.)

### 3. Nothing blocks but a safety rule

On the writes a person runs as part of the work (verify --write, Apply to every repo, the map's
Apply, `atticus sync`):

| Today's refusal (ADR 0197)                        | From this release                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-upgraded`                                    | `atticus upgrade --yes` runs first, and the write goes on. Its catalog changes are its own undo step; its org-pack changes are in the metarepo's history, as every upgrade's are                                                                                                                                     |
| `hand-edits`                                      | The edits are kept as the person's (curated, as `atticus catalog edits --curate` does), listed, and the write goes on. `--discard-edits` stays, to discard them on purpose                                                                                                                                           |
| `large-removals`                                  | Rarely reached: a fact the last read stored that a new read leaves out is kept while every file it cites is unchanged (verify's carry checks its lines again), and listed; a person removes one on the map. The removals left (their files changed) are written and listed with what explains each. No count to type |
| `unexplained-removals`                            | Stays: a record removed with no cause is a fault of the build, reported as one                                                                                                                                                                                                                                       |
| `nothing-read`, `empty`                           | Stay: they guard against a read that failed                                                                                                                                                                                                                                                                          |
| `newer-atticus`, and a fact a newer Atticus wrote | Stay: this Atticus can't read them. A fact with a field or kind no Atticus writes is kept and not read, and named as the assistant's (beta.32)                                                                                                                                                                       |
| A `build.json` that doesn't read                  | Stays: there is nothing to keep. It is reported under `hand-edits` today; the write tells it apart (`unreadableManifest`) and doesn't go past it                                                                                                                                                                     |

A write that confirmed a plan or a count (the app's confirm, `--allow-removals`,
`--discard-edits`) runs as asked. `atticus catalog build` keeps every refusal and its flags: it
is the command for looking at a build before it is written. `--allow-removals` leaves the help
of the other commands.

### 4. The model pairs what the join left loose, inside Apply

After a write, each call the join left loose goes to the model with the entries of every repo the
estate names as a candidate for it (by host, server name or route), not one repo at a time. A
pairing is drawn as the AI's when the verifier checks every line it cites on both sides: the
call's, the entry's and each line it rests on. That replaces ADR 0181's bar for these calls
(that the shapes rank the API first, or a person's rule agrees), which a gateway's targets
never meet. A person can move it, and their correction spreads as ADR 0208 says. Stored per
commit: a call is paired again only when a file its claim cites changes.

It runs where a model may decide in a run (`decideIn`: today `copilot-acp`; no runtime is added);
through the `hand-off` runtime, the calls become one prompt and its answer is read as Match's is
today. Inside an assistant's own session it proposes and decides nothing (ADR 0115).
`runtime.yaml`: `apply.pair: true|false`, default true where AI is allowed; it decides for these
calls in place of `decide.links`, whose default stays `propose` for the rest. With AI off, a
runtime that may not decide, or the budget spent, the calls stay listed and the Apply ends
normally.

### 5. A budget, said before it is spent

`runtime.yaml`'s `budgets` gains optional limits: `{ per: run|day|month, sessions?, tokens? }`,
whichever the provider bills. Every run that calls a model says first how many sessions and
tokens it plans, and checks that its result can be written (no lock held, the facts read) before
its first request. A run that would pass the budget asks, or in an unattended run stops before it
starts. A read sends its files in as few sessions as the model's limit allows.

### 6. The deterministic readers off by default

A repo is read by its recipe or by the model. The readers run only where an org pack turns them
on (`readers: on`), and `atticus framework`, `dialect` and `onboard` say so. Their removal is not
part of this release: about 27 source files import `packages/extractors`, the verifier among
them (`verify/src/skipped.ts` reads OpenAPI with it) and the build (`scanner/src/build.ts`), and
C2 is referenced by the repos manifest and C4's plugin `appliesTo.dialects`, and shares its
template grammar with C3. A later ADR moves the shared readers (XML, OpenAPI) into core, decides
C2's end with a migration, and then deletes the package.

### 7. The change path

A sweep of every stop from a request to an archive (2026-11-24, `packages/changes`, `planner`,
`naysayer`, `knowledge`, `taskrun`, `release`, `initiatives`, `openspec-adapter` and their
commands) found 58. Each is one of three things, and is treated so:

| Kind                        | Count | From this release                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A safety rule (hard rule 6) | 15    | Stays: a person's approval of every hand-off, sync merge, return, push, task PR, release PR, ADO write and manual-host step; none in an assistant's session; protected and default branches never pushed; only a change's own PR approves its gate; a document never accepted over a verified fact; constitution rules never waived |
| A gate                      | 17    | Becomes an open item on the change. A hand-off goes ahead with them, and its PR lists them under "Open items" for the person who approves it on the Git host: that approval is the gate. Each is still shown where it arose, and `atticus change status` lists them all                                                             |
| An error                    | 26    | Stays, and says its one fix: input Atticus can't use (a malformed requirements row, a missing brief, no change of that id, a patch that doesn't apply, an unsupported OpenSpec, a build that fails after its fix rounds). Not a gate: there is nothing to go ahead with                                                             |

The sweep's 58 rows: 15 safety rules, 17 gates, 26 errors. Inside one gate, the open blocking
findings at a hand-off, three things are carved out and keep blocking as safety rules: a
constitution-layer finding, and the
ingested-content quarantine rule (`naysayer/src/defences.ts`, `layer: constitution`), keep
blocking a hand-off, whatever its approval; an unfinished or failed critic round (`round-unfinished`)
stays a refusal, the change path's `nothing-read`. So a hand-off's open blocking findings become
open items only when they are org or team findings.

The 17 gates: a later stage waits for an earlier one with a blocking finding; open questions on
a stage or a hand-off; a drafting finding repeated three drafts; a stage's acceptable findings
waiting for a waiver; an assistant's "not relevant" proposal waiting for a person; a checking
round past its limit; a person's own edit failing the checks (`--force` goes); open blocking
org and team findings and gaps at a hand-off (`checkFindings`, `packages/changes/src/lifecycle.ts`); a
platform's mandatory gate with no critic round; `maxAuthorRounds` used up; an org or team rule
marked `waivable: false`; the quick path's "In the code" table and acceptance criteria; OpenSpec
validation's warnings (its errors stay errors); a task held by `(after …)`; a task branch with
commits its change branch lacks; a release PR stale or not merged at go/no-go; post-release
findings and unticked tasks at archive.

Kept besides: a step that would overwrite files a person wrote still asks for `--force` (a
copy is kept); an AI answer still can't write outside its repo, in `.git` or over the
constitution; and an assistant still can't waive, accept or dismiss for a person (ADR 0115).

One gap the sweep found is closed: outside an ACP session, an assistant's terminal could pass
`--approve` to `change handoff`, `change sync` and `task run`, recorded under the Git user
(`cli/src/main.ts`). The check the waive command already makes there (`underAssistant`,
`cli/src/assistant-env.ts`) is applied to every `--approve`.

### 8. One command, and smaller releases

`atticus sync` reads what changed (recipe, then model), verifies, writes, pairs and says what is
open; the app's Apply button and both editors run it, and every other map command keeps working
off the first page of help. The size check (`scripts/check-size-budget.mjs`) becomes: no more
lines of source than the last release. For beta.33 alone the owner set an allowance of 3,200 lines over beta.32
(2026-11-25): every unused line outside the readers was taken out, and the readers wait for the
later ADR of part 6. It ends when beta.33's baseline is recorded.

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
