# 0206. Operations and quick changes are checked against the code, and impact, map and estimate read a quick change

- Status: accepted (2026-11-21, by the owner, with the recommended answers: a not-checkable claim is a blocking, waivable `conform.not-checked` finding at Build, QA and Go/no-go, the waiver's reason saying how it was checked, and "couldn't confirm" stays a note listed in the hand-off PR; the quick path refuses its plan hand-off without the `## In the code` table, a row with Has `other` always being a way on; on a quick change impact lists receivers under "reaches", never as breaks; ADR 0114's flow checks are unchanged in beta.30)
- Date: 2026-11-21
- Release: 2.0.0-beta.30, closing two of the [known limits](../plan/v30.md#known-limits-of-beta30) by the owner's decision of 2026-11-21 (nothing stays out of beta.30)
- Amends: ADR 0203 (its addendum: "point 6, conformance of `sets`, is not built in beta.30"), ADR 0201 (decision 1's `quick-define` step and the plan's "one deterministic check on the quick path"), ADR 0114 (the conform gate's rules and stored result)
- Extends: ADR 0074 and ADR 0124 (every fact cites its code), ADR 0108 (the change map), ADR 0109 (the estimate), ADR 0144 (impact), ADR 0195 (facts carried to a commit)
- Contracts: C3, additive: the built-in conform rules gain two rules (pack 1.0.0 to 1.1.0); the finding shape is unchanged. C4, additive: optional fields on the conformance, map, impact and estimate bodies and the local API's next minor. C1, C2, C5, C6 and the facts file are unchanged. No stored file changes shape; no migration. The planner's `_operations.yaml` (no numbered contract) gains three optional keys under `sets` before beta.30 ships.

## Context

Two gaps are written down as known limits of beta.30:

1. **Operations aren't checked against the code.** ADR 0203 part B lets a change plan deployments, pipelines, configuration, secrets, routes and cut-overs. Its addendum left the check out, and the product says so: "This change's work is operations (N): Atticus doesn't check operations against the code in this release" (`packages/cli/src/change-conform.ts:51`, `packages/ui/src/copy.ts:1871`).
2. **The quick path is checked at its door only.** "On the quick path nothing checks the built code against the design, and impact, map and estimate have no target flows to read" (`docs/plan/v30.md:158`).

The owner's decision of 2026-11-21: both are closed in beta.30. This ADR is the smallest design that does it with one mechanism: **a change states what the code will have; after the build, each statement is looked for in the verified facts of the branch's commit and gets one of five outcomes, each cited to a file and line.**

## How it is today

Read in the code on `release/b30` at `31a94749`. No code was run.

- **What conformance checks.** `atticus change conform` scans each repo's branch and its base from a detached worktree of the base clone (`packages/taskrun/src/conform.ts:101`), with the facts carried to that commit (`carryFacts: true`, `:117`). The planner compares the records with the target flows only: calls, publishes, tables, columns, migrations, triggers, endpoints (`packages/planner/src/conform.ts:30`). A change with no target flow stops there (`taskrun/src/conform.ts:300`). The files under `target-flows/` that start with `_` are passed over (`planner/src/conform.ts:655`).
- **Rule 4 in the check.** Only facts with nothing unread can say a thing is missing; otherwise the step is "couldn't confirm", with the command to read again (`planner/src/conform.ts:252` to `:264`). A thing found by the built-in readers alone still counts as found (`:285`, `:354`).
- **How it reports.** Each repo's newest result is `conform/<repo>.yaml` (`Api.ConformRepoResult`, `packages/core/src/api.ts:4048`, `z.object`, so an older reader drops a key it doesn't know). Missing and still-there are blocking, waivable C3 findings; not in the design is a risk (`packages/taskrun/rules/conform.yaml`). The conform gate holds the Build, QA and Go/no-go hand-offs (`packages/changes/src/lifecycle.ts:486`, `:489`). At the end of a task run the result is a note (`taskrun/src/conform.ts:483`); with no target flow it says nothing (`:497`). The app's Code against design screen (`packages/ui/src/screens/work/Conformance.tsx:128`) and the MCP tool `change_conformance` (`packages/cli/src/mcp.ts:342`) read the stored result.
- **Operations.** `target-flows/_operations.yaml`, version 1 (`packages/planner/src/stages/schema.ts:502`). An operation has `kind` (one of six, `:142`), `repos`, `what`, optional `today`, `sets` (`platform`, `env`, `host`, `key`, `:478`), `after` and `undo`. One schedule orders its tasks; a task is labelled `o<operation>.<repo>` by file order (`stages/operations.ts:187`, `:196`). A plan it can't order is refused (`operation.order`, `:357`).
- **What the facts hold of operations.** A `deploy` fact has `platform`, `env`, `host`, `basePath`, `exposes`, `pipeline`, `resourceName` (`packages/core/src/schema/facts.ts:259`). A `config` fact has `key`, `value` or `source`, `env`, and refuses a value that looks like a secret (`facts.ts:640`). The verifier checks on the cited line a deploy fact's `resourceName` (else the cite's value) (`packages/verify/src/verify.ts:818`), its `host` and `basePath` (`:1417`), and a config fact's `key` (`:828`). It does not check `platform`, `env` or `pipeline` on the line: they are the assistant's reading of it.
- **What reaches C1.** A deploy fact becomes a `Deployment` with `env` and `platform`, and no `ingress`: `host` and `basePath` are not projected (`packages/core/src/facts.ts:967` to `:1000`). A config fact becomes a `Setting` (`:1050`). A pipeline is a `QualityAsset` the built-in readers make (`packages/extractors/src/platform/pipelines.ts:226`); no fact kind records one (a deploy fact's `pipeline` is a name, not checked on the line).
- **A quick change** is `requirements.md`, `proposal.md`, `specs/`, `design.md` and `tasks.md`, with no target flow (ADR 0201). Its footprint is its `tasks.md` repos and its `## Planned` ids; "what the proposal, specs and design say they change can't be read for sure from prose" (`packages/changes/src/footprint.ts:499`). The field estate's quick change, `publish-settled-refunds`, says what it publishes only in sentences (`fixtures/forge-field/metarepo/openspec/changes/publish-settled-refunds/specs/settled-refunds/spec.md`).
- **Impact, map and estimate** each start from `targetFlowsOf` (`packages/cli/src/change-map.ts:55`) and say "has no target flows yet" when there is none (`change-impact.ts:19`, `change-map.ts:167`, `change-estimate.ts:142`). The estimate counts operation tasks and leaves them out ("estimates.yaml has no class for operations yet", `change-estimate.ts:102`). The map draws `ChangeFlowIn` values (`packages/diagrams/src/views.ts:540`). Who receives a record is `receiversOfAll` (`packages/index/src/graph.ts:344`), what `ask` answers.
- **A quick change's checks before build** are its files being there and filled (`checkArtifacts`, `lifecycle.ts:301`), the critic, and `openspec validate --strict`. The plan calls the requirements door "the one deterministic check on the quick path" (`docs/plan/v30.md:79`).

## Decision

### 1. One idea: a stated claim, looked for in the facts

A **claim** is one thing a change says a repo will have after the build: an endpoint, a listener, a call, a publish, a table, a column, a migration file, a deployment, a route, a setting, a secret's key, a pipeline file, a cut-over, or something else a person checks. Two places state claims:

| Path        | Where the claims are                                             | Written by                              |
| ----------- | ---------------------------------------------------------------- | --------------------------------------- |
| Staged path | `target-flows/_operations.yaml`, an operation's `sets` (point 2) | the architecture stage, as today        |
| Quick path  | `design.md`, the table under `## In the code` (point 4)          | the spec writer (ADR 0201), or a person |

Target flows stay as ADR 0114 checks them. Claims are checked beside them, by one new function, `conformClaims` in `packages/planner/src/conform-claims.ts`, with no model and no network: the same commits and files give the same answer.

### 2. Operations' claims (part A)

`sets` gains three optional keys: `basePath`, `file` and `value`. `_operations.yaml` stays version 1: beta.30 is its first release, so no file of the older shape exists. A `value` is refused on a `secret` and redacted as an operation's words are.

| Kind         | What `sets` may give  | Looked for in, at the branch's commit                                                                                       |
| ------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `deployment` | `platform`, `env`     | a `deploy` fact of the repo's component (or with `exposes` naming it, read in another repo the operation names)             |
| `route`      | `host`, `basePath`    | a `deploy` fact's `host` and `basePath`, as above                                                                           |
| `config`     | `key`, `env`, `value` | a `config` fact of the repo with that key (and env)                                                                         |
| `secret`     | `key`, `env`          | a `config` fact with that key whose value is kept elsewhere (`source`); its value is never read, compared or printed        |
| `pipeline`   | `file`                | the file in the commit's tree (`git ls-tree`), cited at line 1, as a migration file is today (`planner/src/conform.ts:481`) |
| `cut-over`   | nothing               | never looked for: an act in a live system, which Atticus never connects to (rule 6)                                         |

The check reads **facts**, not the catalog's records, because `host` and `basePath` never reach a `Deployment` (`core/src/facts.ts:990`). The scan at a commit already carries the snapshot's facts there and verifies them again (`packages/scanner/src/facts-scan.ts:59`); it returns them beside the records (`ScanAt` gains `facts`, an internal type).

A task scope works as for flows: task `o2.3` checks operation 2 in its third repo; a task with no such label checks every operation of its repo.

### 3. Five outcomes, and what the person does next

| Outcome                 | When                                                                                                                                                                      | Cited                                     | What the person does next                                                                                                                                                                                                         | Finding                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **present**             | a verified fact of the repo at the commit says what the claim says                                                                                                        | the fact's file and line                  | nothing; the reviewer reads the line                                                                                                                                                                                              | none                                                        |
| **present differently** | a verified fact of the same subject says something else: another platform for that env, another host, the key in another env, a secret's key set to a literal in the repo | the fact's file and line, and the claim's | make the repo do what the claim says on the branch, or change the claim if the design was wrong (staged: `atticus change architecture <id>`; quick: the row), then check again; or waive it with a reason if it is right as it is | `conform.differs`, blocking, waivable (new)                 |
| **missing**             | the facts cover the commit with nothing unread, and none has the subject                                                                                                  | the claim's file and line                 | build it on the branch in the repo the claim names; if it lives in a repo the change doesn't name, add that repo to the operation or the row                                                                                      | `conform.missing`, as today                                 |
| **not checkable**       | nothing a fact holds can show it: a cut-over, a pipeline with no `file`, an operation with no `sets`, an `other` row, a secret's value                                    | the claim's file and line                 | check it by hand and say so: `atticus finding <change> <id> waive --reason "<how it was checked>"` (question 1)                                                                                                                   | `conform.not-checked`, blocking, waivable (new; question 1) |
| **couldn't confirm**    | a file changed since the facts were read and no fact covers it, the repo was read by the built-in readers only, or nobody has read the repo                               | what was found, else the claim            | read the repo again (`/atticus-map <repo>`, then `atticus verify <repo> --write`) and check again, as the message for flows says today (`planner/src/conform.ts:255`)                                                             | none, as for flows; listed in the hand-off PR (point 6)     |

Two rules keep this honest under rule 4:

- **Present comes from facts only.** A record the built-in readers alone found is "couldn't confirm", with its cite: the readers are a cross-check, never the path to accuracy. This is stricter than ADR 0114's flow items, which take a reader's record as found; question 4 asks whether flows follow.
- **A value the verifier didn't check on the line is said to be so.** `host`, `basePath` and `key` were checked on the cited line by `atticus verify`. `platform` and `env` were not. When the claimed `platform` or `env` is also a word on the fact's cited line or a `cite.with` part (read again here with `git show <commit>:<path>`), the outcome says "written on the line"; otherwise it is still present and says "the assistant's reading of <file>:<line>". A `value` is present only when it is written on the cited line.

A secret's value is never put in a result, a finding, a log or a prompt. A `config` row's value is shown redacted, as a fact's quote is.

### 4. The quick change's claims (part B, 1)

The spec writer (ADR 0201's amendment, point 6) writes one more section in `design.md`:

```markdown
## In the code

| Repo         | Task | Has       | What                                                               | Spec                                           |
| ------------ | ---- | --------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| forge-svc-01 | e2   | publishes | `forge.items.settled`                                              | settled-refunds: A settled refund is published |
| forge-audit  | e1   | listens   | `forge.items.settled`                                              | settled-refunds: A settled refund is published |
| forge-deploy | m4   | route     | host anvil.forge.example                                           | service-hosting: A moved service is served ... |
| forge-deploy | m5   | cut-over  | undo: point the route back at the hosts, which stay up one release | -                                              |
```

- **Repo** is a `## <repo>` heading of `tasks.md`. **Task** is a task id under it, or `-`. **Spec** is `<capability>: <Requirement name>` of a `### Requirement:` under `specs/`, or `-`.
- **Has** is one word of fourteen: `serves` (`METHOD /path`), `listens` (a topic), `calls` (a component or repo, then `METHOD /path`, or an Endpoint id), `publishes` (a topic), `table`, `column` (`table.column`), `migration` (a file), `deployment`, `route`, `config`, `secret`, `pipeline` (pairs such as `platform anvil, env prod`, as `sets` takes them), `cut-over` (`undo: <sentence>`), `other` (free words: a person checks it).
- The code rows are compared exactly as a target flow's step is, with the same helpers (`planner/src/conform.ts:145` to `:214`): `serves` and `listens` as a new flow's trigger, `calls` and `publishes` as an added step's `to`, `table`, `column` and `migration` as a store. The operation rows become operations in memory (kind, the row's repo, `sets` from the pairs) and go through point 2. Every row gets one of point 3's outcomes.
- **Not in the design** works for a quick change too: what the branch adds that no row names (a call, a publish, an endpoint, a table, a column) is `conform.unexpected`, a risk, as today (`planner/src/conform.ts:577`).

**The table is checked before the plan hand-off** (question 2). For a change whose type is quick (`quickPathOf`), `checkArtifacts` reads the table with the requirements file's hardened table reader (`packages/changes/src/requirements.ts:155`: fences, comments, a NUL, CRLF, UTF-16), factored out so both files share it. A problem is one reason, `design.code-table` (reason codes are strings, `packages/changes/src/errors.ts:4`), with its line, so `quick-define`, `atticus change status` and `atticus change handoff --approve` all say it from one place:

| Refused when                                                                                                        | The line says                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `design.md` has no `## In the code` table                                                                           | "design.md doesn't say what the code will have: add ## In the code with the columns Repo, Task, Has, What, Spec, a row for each thing a repo's code or deployment will have. A repo whose work no scan can see gets a row with Has other." |
| a row's Repo, Task or Spec isn't in `tasks.md` or `specs/`                                                          | "design.md:<n>: <cell> names <x>, which <tasks.md / specs/> doesn't have."                                                                                                                                                                 |
| Has isn't one of the fourteen words, or What doesn't read for it                                                    | "design.md:<n>: a <has> row needs <what it needs>, for example <example>."                                                                                                                                                                 |
| an id in What (a component, a topic, an Endpoint id) isn't in the map and isn't under `## Planned`                  | the door check's words for `requirements.unknown-id`, with design.md's line                                                                                                                                                                |
| a `tasks.md` repo has no row                                                                                        | "design.md: <repo> has tasks and no row in ## In the code."                                                                                                                                                                                |
| a `cut-over` row has no undo that says how (the rule of `stages/operations.ts:48`), or a `secret` row gives a value | "design.md:<n>: …" with the rule's words                                                                                                                                                                                                   |

**The spec deltas are netted, not parsed for meaning.** Every name of the map on a line of a spec delta (a topic, an Endpoint id, a `METHOD /path`, a component, a repo) that no row's What names is a note, never a refusal: "specs/<cap>/spec.md:<n> names <x>, and no row of ## In the code does, so the code isn't checked for it." It shows in `atticus change status` and in the plan hand-off's PR. What a sentence means (who publishes, what is called) is never read from prose (`footprint.ts:499`).

### 5. Impact, map and estimate read a quick change (part B, 2)

Each reads the quick change's table when the change has no target flow. Before the table is written, each reads `tasks.md`'s `## <repo>` headings and says what the table would add.

| Command and API                    | From the table                                                                                                                                                                                                                                                                                                                                                                 | With `tasks.md` only                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `atticus change map <change>`      | The rows become, in memory, the `ChangeFlowIn` values `changeView` already draws (`views.ts:540`): one a repo's component, `calls` and `publishes` as added steps with `to`, `serves` and `listens` as its entries, the store rows as stores. A part the map lacks is marked + new only when it is under `## Planned`. Operation rows aren't drawn; the command says how many. | The repos as boxes, + new when planned, with no line, and "design.md doesn't say what the code will have yet, so no line is drawn." |
| `atticus change impact <change>`   | For each record a row names that the map has (an entry served, a topic published or listened to, a table, a component called): who receives it, by `receiversOfAll` (`graph.ts:344`), with each owner. Listed under "reaches", never as breaks: a quick change says what its code will have, not which fields change, so Atticus can't tell what breaks (question 3).          | "A quick change's impact is read from design.md's ## In the code, which it doesn't have yet."                                       |
| `atticus change estimate <change>` | One unit a row, classed `quick/<has>` with the suffixes `classOf` adds today (`vendor`, `other-team`, `new-entry`, `new-table`, `packages/release/src/estimate.ts:121`); an operation row `operation/<kind>`. The units cite design.md's line.                                                                                                                                 | One unit a task, class `quick/task`, citing `tasks.md`.                                                                             |

On the staged path the estimate also counts each operation task as a unit, class `operation/<kind>`, citing `_operations.yaml`, in place of today's note that leaves them out (`change-estimate.ts:102`). `estimates.yaml` needs no change: a class is a free string its `match` already takes (`packages/core/src/schema/orgpack.ts:1572`), and a unit no class matches "needs a class", as today.

### 6. What the person sees

`atticus change conform <change>` prints, per repo, the flows' lines as today, then the claims:

```
forge-svc-00 at change/move-to-anvil (3f2a91c0d4e7, from 9aa433e35611): 0 found, 0 missing, 0 still there, 0 not in the design.
  Stated in target-flows/_operations.yaml:
  PRESENT              deploy-anvil: forge-svc-00 runs on anvil in prod, written on the line  forge-svc-00:deploy/anvil.yaml:4
  PRESENT DIFFERENTLY  route: forge-svc-00's host is hosts.forge.example, not anvil.forge.example  forge-svc-00:deploy/anvil.yaml:9
    Next: give the branch the host the operation sets, or change the operation (atticus change architecture move-to-anvil), then check again.
  NOT CHECKABLE        switch (cut-over): an act in a live system, which Atticus never connects to.
    Next: check it by hand, then: atticus finding move-to-anvil conform-not-checked-cut-over-switch-forge-svc-00 waive --reason "..."
  COULDN'T CONFIRM     settings: no fact covers what changed in deploy/anvil-values.yaml since forge-svc-00 was read.
    Next: /atticus-map forge-svc-00, then atticus verify forge-svc-00 --write, and check again.
```

The words "Atticus doesn't check operations against the code in this release" go from the CLI and the app (`change-conform.ts:51`, `copy.ts:1871`). The end of a task run notes claims as it notes flows (`taskrun/src/conform.ts:497` gains "or claims"). The app's Code against design screen gets a Stated section with the five outcomes, each with its cite and its next step, and empty, loading and error states; its words are new keys in `packages/ui/src/copy.ts`. The Build, QA and Go/no-go hand-off PRs' review block (`packages/changes/src/handoff.ts:283`) lists each claim that is not present, so a reviewer reads them on one page. `change_conformance`'s description names claims.

## What is refused

- A quick change's plan hand-off without a readable `## In the code` table (point 4; question 2).
- `sets.value` on a secret; an `undo` that doesn't say how on a quick `cut-over` row.
- Nothing else new. A blocking claim finding holds the Build, QA and Go/no-go hand-offs as every conform finding does, and a person waives it with a reason; an assistant can't (`packages/naysayer/src/act.ts:218`).

## What it does NOT check, and why

- **What a requirement's prose means.** A sentence can't be read for sure; the net only names map names no row states.
- **Fields, behaviour and scenarios.** That a call sends the right fields, that a scenario's THEN holds: tests and reviewers, as ADR 0114 says of flows.
- **Removals on the quick path.** The table has no "stops" word. A change that removes a call or retires a component alters a runtime step the map holds, so the staged path (target flows with today's steps, ADR 0193) is where it is checked; the quick path's hint already says so the other way round.
- **A cut-over, a pipeline's steps and runs, a secret's value, anything in a console or a live system.** Rule 6: Atticus never connects to them. They are not checkable, and listed.
- **A repo the claim doesn't name.** Only the repos a claim names (and facts with `exposes` read in them) are scanned.
- **`today` after the build.** That the old deployment is still there for its undo is a person's to see.
- **That a deployment runs.** A fact says a file declares it, not that it is up.
- **That the cited line is right beyond what verify checks.** `platform` and `env` are said to be the assistant's reading unless written on the line.

## Contracts and version bumps

| Contract   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Bump                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| C1         | None. Deploy and config facts are read as they are; nothing new is projected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | None                     |
| Facts file | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | None                     |
| C3         | `packages/taskrun/rules/conform.yaml`: `conform.differs` (blocking, waivable) and `conform.not-checked` (blocking, waivable; question 1). The `Finding` shape and the gate list are unchanged.                                                                                                                                                                                                                                                                                                                                                             | Rule pack 1.0.0 to 1.1.0 |
| C4         | `ConformRepoResult` gains optional `claims` (outcome, check, repo, from `{ file, line, operation?, task?, spec? }`, what, expected, found, record or fact id, `at`, why, next, finding) and `counts.claims`; `ChangeConformance` gains optional `claims` (how many). `ChangeMap` gains optional `from` and `rows`; `ChangeImpact` optional `from` and `reaches`; an estimate unit optional `from`. A new hand-off reason code, `design.code-table`. Every field is optional, and the bodies are `z.object`, so an older reader drops what it doesn't know. | Local API's next minor   |
| C2, C5, C6 | None. The table's format is in the spec writer's starter and the define-change skill (ADR 0201, starter files, no schema), not in the org-flow design template, because on the staged path Atticus writes design.md itself. Org-flow stays 3.                                                                                                                                                                                                                                                                                                              | None                     |
| Stage file | `_operations.yaml` `sets`: optional `basePath`, `file`, `value`, before its first release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None; version 1          |

## Migration

None is needed. A stored `conform/<repo>.yaml` without `claims` reads as it did; a change drafted at beta.28.5 has no `_operations.yaml` and no quick type. The test is `packages/cli/test/upgrade-b30.test.ts`, on its beta.28.5 metarepo with a change done through stories and a stored conform result and round: after `atticus upgrade`, every file is byte for byte the same, `atticus change conform <id> --latest` prints what it printed, and a result written by beta.30 still parses with the beta.28.5 shape of `ConformRepoResult` (kept as a copy in the test folder).

## Tests that prove it (written first, failing)

- **Golden files.**
  - `fixtures/conform-operations/`: an `_operations.yaml` with every kind, the deploy and config facts at the base and at the branch's commit (JSON lines, as the facts files are), the commit's file list, and `expected/result.yaml` and `expected/findings.yaml`. Each outcome for each kind: a deployment present and written on the line, present as the assistant's reading, present differently (another platform), missing (nothing unread), couldn't confirm (a changed file no fact covers; readers only); a route's host present and differently; a config key in another env; a secret by reference, and a secret's key set to a literal (the literal appears in no output); a pipeline file present and missing; a cut-over and an operation with no `sets` not checkable. A task scope `o2.3`.
  - `fixtures/conform-quick/`: a quick change's `design.md`, `tasks.md` and `specs/`, the records before and after: `serves` found, `listens` found, `calls` missing, `publishes` found, an endpoint the branch adds and no row names (not in the design), an `other` row not checkable.
  - `packages/changes/test/code-table.test.ts`: each refusal with its line; the shared reader's cases (fences, comments, NUL, CRLF, UTF-16) for both files.
  - Golden output of `change map`, `change impact` and `change estimate` on the field estate's quick change, with the table and with `tasks.md` only.
- **The field-shaped estate** (`fixtures/forge-field`, `packages/cli/test/field-estate.ts`): it holds no deploy fact today. It gains, as a field report's shape before its fix: deploy facts (platform `hosts`, env `prod`, a host) and a config key for the moved services, and `publish-settled-refunds` gains its `## In the code` table. Regenerated with `pnpm fixtures:field`.
- **`packages/cli/test/archetypes.test.ts`, the three changes** (mock model, Linux and Windows):
  - _New product._ The quick change's plan hand-off is refused with no table and goes with it. Its map draws `forge-approvals-api` and `forge-approvals-web` as + new and the call to the refund entry; impact lists that entry's receivers with owners; the estimate has a unit a row. On a branch commit: `serves` and the table are present; the planned repos with no clone say to create and add them.
  - _Migration in two waves._ Staged (`sets: { platform: anvil, env: prod }`) and quick (the same as rows): wave 1's first service present, its second present differently (still on `hosts`), wave 2's couldn't confirm (its descriptor unread); the cut-over not checkable, waived by a named person with a reason, after which the Go/no-go hand-off is not held by it. The estimate counts the operation tasks.
  - _New event._ `publishes forge.items.settled` present in the publisher; `listens` in `forge-audit` couldn't confirm ("hasn't been read"); impact's receivers of the topic are the components `atticus impact forge.items.settled` names; the net is silent because the spec delta's names are all in rows.
  - Nowhere does the output say "doesn't check operations".
- **Unit and screen tests:** `planner/test/conform-claims.test.ts`, `taskrun/test/conform.test.ts` (repos from claims, the end of a task run, finding ids stable across a redraft), `cli/test/mcp.test.ts`, `ui` tests of the Stated section's states and WCAG 2.1 AA checks, `core/test/api.test.ts` (an old result parses), and `upgrade-b30.test.ts` as above.

## Rough size

About 1,200 lines that aren't tests, on top of the plan's 4,000:

| Part                                                                              | Lines |
| --------------------------------------------------------------------------------- | ----- |
| `conformClaims` (five outcomes, six kinds, the line re-check, task scope)         | 260   |
| taskrun's check (repos from claims, findings, counts, facts from the scan), rules | 140   |
| The table reader factored out, the table's checks, the net, the hand-off reason   | 230   |
| Map, impact and estimate from the table and from `tasks.md`                       | 240   |
| CLI words, MCP, API fields, hand-off PR lines                                     | 130   |
| The app's Stated section, copy keys                                               | 120   |
| The spec writer and the skill (prompt text, not code)                             | 40    |

## Risks

- **Most claims will read "couldn't confirm" at first.** A branch's new deploy files are unread until someone reads the branch, so the honest answer is often that one. The message names the one command; field use says whether reading the branch on every task run is too slow.
- **The spec writer can write a wrong table.** The door refuses with lines, and the run with a real model before the release (plan step 6) reads what it writes.
- **The net may name a word that is no claim** (a topic named in a scenario's GIVEN). It is a note, never a refusal.
- **The map draws rows as if they were steps.** `changeView` assumes flows; the golden output on the field estate is where a wrong picture shows.
- **A second check on the quick path** goes against the plan's "one deterministic check" (question 2).
- **Not verified:** no code was run. Whether `atticus verify <repo> --write` run on a task branch moves the catalog's facts snapshot to that branch was not traced; it is the advice the check gives for flows today. The line numbers of the verifier's checks were read, not exercised.

## Questions for the owner

1. **Does "not checkable" hold the Build, QA and Go/no-go hand-offs until a named person says they checked it?** Recommended: yes. Each not-checkable claim is a `conform.not-checked` finding, blocking and waivable, and the waiver's reason is how it was checked (ADR 0029's mechanism, in the hand-off PR). A migration's cut-over is its riskiest step; without this, nobody named looks at it. "Couldn't confirm" stays a note, as for flows, and is listed in the PR, because its next step is to read again, not to vouch.
2. **May the quick path have a second deterministic check, the `## In the code` table, refusing the plan hand-off without it?** Recommended: yes. Without it nothing after the build has anything to check a quick change against, and impact and the map have nothing to read; the `other` row is always a way on, so no change is ever stuck.
3. **On a quick change, does impact count the receivers it finds as breaks?** Recommended: no. List them under "reaches" with their owners, apart from breaks and may-break, and keep them out of the critic's link rule and the estimate's drivers: a quick change states no fields, so calling a receiver broken would be a guess, and the staged path is where breaks are worked out.
4. **Should ADR 0114's flow items follow the same rule 4 as claims (found only from facts) in beta.30?** Recommended: not in beta.30. Claims take it from the start. For flows it would change today's answers on every repo read by the built-in readers only, and the journeys' and archetypes' expected results with them; it belongs with the next field report on conformance, as its own change.

## Addendum, 2026-11-21: as built

Where a point below differs from the text above, the point below holds. The contracts are as the header says.

- **The open question, traced.** `atticus verify <repo> --write` reads the repo's checkout that `repoFor` gives, the base clone, at its own HEAD (`packages/cli/src/facts-files.ts:49`, `packages/cli/src/verify-commands.ts:474`, `:486`), writes the facts snapshot at that commit and builds the catalog from it. A task branch lives in the workspace's worktree, not the base clone, so "read again, then `verify --write`" never covers a branch's files; run with `--dir <worktree>` it would move the catalog onto unmerged code. So the check reads the branch's facts from the change folder instead: the assistant writes them to `conform/facts/<repo>.jsonl` (facts at the branch's commit, each citing its file and line), and the check verifies them against its own detached worktree of the commit with the verifier (`branchFactsAt`, `packages/scanner/src/facts-scan.ts`), never writing a snapshot or the catalog. The files they cite are no longer unread. "Couldn't confirm" says this for a file no fact covers, and names the folder; for a repo read by the built-in readers only, or by nobody, it says to read the repo (`/atticus-map <repo>`, then `verify --write`). ADR 0114's flow items keep their own advice (the owner's answer 4); it has the same limit, and the next field report on conformance is where it goes.
- **Claims are compared with facts, code rows too.** A row's endpoint, listener, call, publish, table and column are looked for in the `entry`, `call` and `store` facts of the commit, not in the catalog's records, so present always rests on a fact verified on its line. Present differently and missing need facts with nothing unread; otherwise the outcome is "couldn't confirm" (a matching fact may be in the file no fact covers). A file of the commit's tree (a pipeline's, a migration's) is git's to say, whatever the facts cover.
- **`calls` takes `<component or repo> METHOD /path`.** The Endpoint-id form is not built: the table check would need the catalog to read it.
- **A claim's repo with no clone here** is said, never thrown: its claims couldn't be confirmed, the result has no commit, and its problem names `atticus workspace sync`, or, for a repo no manifest lists, `atticus repo add <its clone URL> --id <repo>`. A repo a target flow names still refuses as before.
- **The net** names each name once, at its first line in a spec delta.
- **The table reader** shares the requirements file's decoding (a byte-order mark, CRLF) and its fence and comment rules, in its own small reader (`packages/changes/src/code-table.ts`); the requirements parser is unchanged. The undo rule moved to `packages/changes/src/undo.ts`, shared by both paths.
- **The local API** carries the new fields under 3.19.0, beta.30's minor, which isn't released yet.
- **Two golden files corrected while building**, both hand-written before the code: in `fixtures/conform-operations`, a secret's literal beside a file no fact covers is "couldn't confirm", not "present differently" (the rule above); and the route's fact cites the line its base path is written on.
- **Size:** about 2,200 lines of code that aren't tests or comments (2,594 added, 148 removed, with comments, the starter text and the rules), against the estimate of 1,200: the five outcomes for fourteen kinds, the app's three views and the no-clone path took more than the estimate allowed.

## Addendum, 2026-11-22: the review of the build

An independent review of the build found these; each is fixed with its tests. Where a point below differs from the text above, the point below holds.

- **A secret's key.** A secret written as a literal is `source: literal:<file>` with no value (the `/atticus-map` rules; the verifier refuses a secret-shaped value), or a value: it is **present differently**, "set to a literal in <file>: keep it in the secret store", a `conform.differs` finding, whatever else is unread: a verified fact found it on its line (this replaces the as-built note that a literal beside a file no fact covers is couldn't confirm). A reference (`env:NAME`, `vault:path`) counts as present only when it is written on the fact's cited lines (the verifier doesn't check a source there); otherwise the claim couldn't be confirmed, "only the assistant's reading", with the file to read again. The value is never read into a result.
- **Written on the line** means the word itself, never a part of a longer one: `anvil` isn't on `name: ledger-anvil`, `prod` isn't on `production` (`wordOn`).
- **The branch's facts** (`conform/facts/<repo>.jsonl`) are read for the branch's commit only, never verified at the base. They are verified beside the repo's other facts at the commit (the snapshot's, carried there), so a branch fact may lean on them; a snapshot fact citing a file they cite gives way to them. For a repo nobody read into facts before, what they don't cover stays unread (the verifier's coverage), so its claims couldn't be confirmed, never missing on facts that don't cover them. An end-to-end test runs this path on a real branch commit with no scan injected (`packages/taskrun/test/conform-branch-facts.test.ts`).
- **`exposes` is built.** A deployment's or a route's claim reads the deploy facts of the other repos its operation names, each scanned at its branch's commit (the same ref, else the change branch), whose `exposes` names the repo or its manifest component; a repo with no clone here or no branch yet is not read. Missing and present differently need nothing unread in those of them that may declare another's deployment, as the verifier reads a repo (its facts serve nothing of their own, or a deploy fact of it names what it exposes): a service of the same migration, read with a file no fact covers, doesn't hold another service's outcome (`packages/taskrun/test/conform-exposes.test.ts`).
- **A fact that names no env**, the only one of its subject, against a claim for one env, couldn't be confirmed, never a blocking present differently. **A pipeline's `file`** is its path in the repo; a migration keeps ADR 0114's rule (its file name wherever the migrations are).
- **A Repo cell that isn't a repo's id** is said ("design.md:<n>: <cell> isn't a repo's id …, so the row isn't checked") and its row passed over; the change's other claims are checked.
- **A quick change with nothing to check yet** (no `## In the code`) is told the quick path's next step, the spec writer's `/define-change <id>` and `atticus change status <id>`, never a stage (ADR 0201), on the CLI and the app. An adopted plain OpenSpec folder is a quick change, so it needs the table before its plan hand-off; the guide says so.
- **A waived or dismissed finding** no longer keeps `atticus change conform` at exit 1. In the app, a change with no target flow leads a repo's result with its claims' counts.
- **Migration, as tested.** The test is `packages/cli/test/upgrade-b30-operations.test.ts`. `--latest` on the stored beta.28.5 result is compared with what the CLI built from the tag `v2.0.0-beta.28.5` printed for it (`fixtures/upgrade-b30/conform-28.5.latest.txt`), before and after the upgrade; every file but git's own is hashed, and only the files the upgrade's steps name (and the folder of each), and its own record, may change.
- **WCAG 2.1 AA of the Stated section** is checked with axe in a journey (`packages/journeys/tests/41-conformance-stated.spec.ts`), with a claim of each outcome.

## Addendum, 2026-11-22: the real-model persona check of beta.30

C4 additive; no schema change, no migration.

- **Impact tells "no table" from "only operation rows".** A migration's `## In the code` of deployment, route, config, secret and cut-over rows was told "design.md has no ## In the code". `ChangeImpact.operations` lists the rows that are operations (each with its line and Has): with no reach, impact says the table's rows are operations the map can't follow, which conform checks, and with reaches it counts them after. A `deployment` row is a reach: its `name` and `ids` are the component the repo deploys, its `receivers` the components the map shows calling it ("Called by …: each must still reach it where it is deployed."), on the CLI and the app.
- **Conform says it found everything only when it did.** "The code has everything the change states it will have…" is printed only when every claim is present and every item found; otherwise a line counts what isn't (couldn't be confirmed; missing, different or to check by hand; waived or dismissed). The exit codes are as they were: a claim that couldn't be confirmed makes no finding. A claim in a repo no manifest lists says first to add it (`atticus repo add <its clone URL> --id <repo>`), then to read it; one in a listed repo with no clone here, to run `atticus workspace sync`.
