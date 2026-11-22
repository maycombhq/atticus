# 0207. Before a run over many repos Atticus says what it will do, three more map tools, a quick change moves to the stages, and a planned topic carries its schema

- Status: proposed (2026-11-22, for the owner's approval before any code)
- Date: 2026-11-22
- Release: 2.0.0-beta.30, items 4, 21, 23 and 26 of [the field plan](../plan/field-reliability-and-ease.md) by the owner's decision of 2026-11-22; item 3's nightly is listed at the end and needs no ADR
- Decides: what ADR 0202 left open ("The plan before a multi-repo action", under Not decided here) and what ADR 0201 and ADR 0203 left open ("moving a change from the quick path to the stages")
- Extends: ADR 0104 (the map tools), ADR 0161 (`atticus map --all`), ADR 0189 (what a change plans), ADR 0195 (undo copies), ADR 0198 (Apply from the app), ADR 0201 (the quick path, the map tools), ADR 0202 (one question, asked once), ADR 0203 part B, ADR 0206 (the `## In the code` table)
- Contracts: C4, additive only: three map tools, two flags and three commands on the command line, and four routes and optional fields in the local API, under 3.19.0, which is beta.30's minor and not released (`packages/core/src/api.ts:769`). `change.yaml` stays version 1 and gains no key. The flow delta (the planner's stage file, no numbered contract) gains one optional key and stays version 2. C1, C2, C3, C5, C6 and the facts file are unchanged. No stored file changes shape; no migration.

## Context

Four things from the field plan are still open in beta.30.

1. A run over forty repos starts the moment it is typed or clicked. What it will touch, how long it takes and how much of it can be taken back are learned on the way.
2. The personas ask the map through `atticus mcp`. They can ask what overlaps (`conflicts`), and have no plain way to ask who owns a thing, who uses it, or which earlier change was like this one.
3. A quick change that turns out to need the stages has one way on today: start a new change and copy the files by hand.
4. A change can plan a new table with its columns, types and retention. A new topic is a name and nothing else.

## How it is today

Read in the code on `release/b30` at `b6d9d53f`. No code was run.

**A run over many repos**

- `atticus map --all` already makes a list: every repo, what it needs or why it is skipped (`planEstate`, `packages/cli/src/map-all.ts:603`), printed by `planLines` (`:833`) with parts and estimated tokens (`:872`). `--dry-run` prints it and stops (`:1368`). Otherwise it is printed and the run starts at once (`:1409`). It ends with the estate join, `verify --all --write` (`:1635`).
- `atticus verify --all` has no list. It reads the repos with facts (`packages/cli/src/verify-commands.ts:240`) and starts (`:276`). Its only estimate is made while it runs, from the repos done so far (`:337`). A file another program holds ends that repo with its own command and the run goes on (`:349`).
- **Apply to every repo** in the app is `POST /api/facts/apply-all` (`packages/cli/src/ui-api-steps.ts:98`): the same command as a job. Past five repos the page says it "can take a long time" (`packages/ui/src/app/propose.tsx:735`, `:804`; `packages/ui/src/copy.ts:5470`). It gives no number.
- **No timing of an Apply is kept.** The build report has counts and lists and no time (`packages/scanner/src/build.ts:4313`). A build's phases are told to a listener the speed tests set and to nobody else (`packages/scanner/src/build-phases.ts:7`). A run's record has when it started and ended (`packages/core/src/run-log.ts:84`, `:86`), for the run as a whole.
- **Nothing looks for a held file before a run.** A write waits for one, up to 45 s on Windows (`HELD_WAIT_MS`, `packages/core/src/fs.ts:164`; `retryHeld`, `:346`), then says which file (`FileHeldError`, `:197`).
- **Version skew** is worked out in one place, `standing` (`packages/cli/src/standing.ts:102`): this Atticus, the metarepo's stamp, the catalog's builder, the extension.
- **Undo keeps five builds** (`UNDO_KEEP`, `packages/scanner/src/build.ts:3420`; older copies removed at `:3589`). Each repo's Apply is a build of its own. So after a run that changed more than five repos, `atticus catalog undo` cannot reach the catalog as it was before the run. An undo puts back the catalog, `build.json` and the stored reads, not the facts files (`:3449`).
- **One question, asked once,** only of a person at a terminal: never with `--json`, under `CI`, in an assistant's session or when the app or an editor started the command (`canAsk`, `packages/cli/src/ask.ts:15`; `confirmOnce`, `packages/cli/src/confirm-once.ts:32`).
- **The word "plan" is taken twice.** `packages/cli/test/ui-api-apply-plan.test.ts:22` tests the list a confirm was shown, sent back so a changed list writes nothing (409). That is the pattern this ADR reuses; it is not a plan of a run.

**The map tools**

- 34 tools, each a read-only command (`MCP_TOOLS`, `packages/cli/src/mcp.ts:51`; `readOnlyHint`, `:493`). An id the map lacks is an answer, not an error (`:527` to `:536`); `conflicts` answers on exit 1 (`:325`).
- **Owners.** `impact` gives each record's owner from the catalog's System, else the manifest or a profile (`packages/index/src/graph.ts:240`; `mapSides`, `packages/cli/src/map-lacks.ts:19`), else "no owner on record" (`map-lacks.ts:59`). `ask "who owns X"` is read as an owner question (`packages/index/src/ask.ts:454`) and then answered with the record alone (`packages/cli/src/index-commands.ts:72`): the owner from a manifest is not in it.
- **Consumers.** Who receives a topic is `receiversOfAll` (`packages/index/src/graph.ts:351`), reached only through `ask` (`index-commands.ts:66`, `:242`); `atticus impact` has no flag for it (`packages/cli/src/main.ts:2755`).
- **Similar changes.** `atticus change similar` gives the archived changes nearest a text or a change, by meaning or by words (`packages/cli/src/similar-changes.ts:74`, `:207`). No tool serves it. The tool named `similar` is about records (`mcp.ts:173`).

**A quick change and the stages**

- A type is quick by its shape (`quickPathOf`, `packages/core/src/schema/orgpack.ts:382`). The built-in staged types start at `define` and list `brief` and `stories` (`packages/core/src/orgpack-defaults.ts:44`).
- `change.yaml` is a contract at version 1, a strict object (`packages/core/src/schema/change.ts:17`, `:105`). Its `type` and `state` are plain values; `history` must run from state to state (`:136`) and an entry may carry a `reason` (`:55`).
- **A person's `tasks.md` reads as the stories stage done by a person** (`packages/changes/src/progress.ts:50`; `personWrittenPlanning`, `packages/changes/src/planning.ts:68`). A quick change's `tasks.md` is exactly that, so a quick change given a staged type as it stands would skip the stage that matters most.
- The feature stage starts from `brief.md`, the stories, or the files attached to the change (`packages/planner/src/stages/feature.ts:491` to `:497`). Attached files live in `inputs/`, are read as data and cited by line (`packages/cli/src/attach-commands.ts:48`; `packages/intake/src/change-inputs.ts:397`).
- `requirements.md` rides with the first phase's hand-off (`packages/changes/src/handoff.ts:171`).

**A planned topic**

- A publish step names where it goes: `to: { component, entry, new }` (`packages/planner/src/stages/schema.ts:352`). A new table beside it has columns, types, classification, a migration file, retention and keys (`:354` to `:380`). A new topic has nothing of the kind.

## Decision

### 1. Before a run over many repos (item 4)

**What the person sees.** In a terminal, before `atticus map --all`, `atticus verify --all --write` and their `--repos` forms start on two repos or more:

```
Before it starts:
  Repos: 38 of 40 (not read yet, left out: forge-audit, forge-portal).
  Builds: 38, one for each repo, each a catalog build.
  Time: about 25 min, from each repo's last Apply on this machine (4 repos have none: the middle of the others is used).
  Held now: facts/forge-ledger.jsonl is open in another program. Close it, or the run waits up to 45 s for it and then leaves forge-ledger not applied.
  Versions: You are on Atticus 2.0.0-beta.30. This metarepo is at 2.0.0-beta.30, and this Atticus reads its catalog.
  Undo: atticus catalog undo takes back the last 5 builds. This run makes up to 38, so it can't all be taken back with undo; commit the catalog first if you may want it back whole.
Start? [y/N]
```

For `map --all` these lines follow the list it prints today, and the Builds line counts the join at the end. The Held line is printed only on Windows and only when a file is held. The Versions line is `standing`'s own line. Only `y` or `yes` starts the run; anything else prints "Nothing started." and exits 1, as a declined confirm does today.

- `--plan` prints the lines and stops, exit 0, anywhere; with `--json` it prints one object. For `map --all` it is `--dry-run` with the six lines added, and `--dry-run` stays.
- `--yes` starts without the question.
- **Where no question can be asked** (a script, `--json`, `CI`, an assistant's session, a job of the app) nothing is asked and nothing new is printed: the run starts as it does today, byte for byte (ADR 0202's rule). An assistant that wants the lines runs the command with `--plan`.
- `atticus verify --all` without `--write` builds nothing and is never asked about; `--plan` works for it.

**In the app,** Apply to every repo, Apply to the repos that wait and the map-all dialog open a panel first, "Before it starts", with the same six rows, a Start button and Cancel. The panel has loading, error and empty states ("Nothing to apply: no repo has been read yet") and is reached and read by keyboard and screen reader (WCAG 2.1 AA). Start sends the panel's `plan` value with the request.

**What is checked, and where it comes from.**

| Row      | From                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repos    | `factsRepos` and the `only` list for verify (`verify-commands.ts:240`, `:316`); `planEstate`'s items and skipped for map                                                                                                                                                                                                                                                                                                                                                                                                     |
| Builds   | one for each repo applied; for map, also one for each part read. Counted from the same lists, never measured                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Time     | **new:** `.atticus/timings.json`, local to the machine and never committed (added to `LOCAL_ONLY`, `fs.ts:794`): for each repo, how long its last written Apply took and when. `verifyCommand` writes it after a write. The estimate is the sum; a repo with no time takes the median of the others; with none at all the row says "No estimate yet: no Apply has been timed on this machine." Worded by `timeLeftWords` (`:252`), never to the second. A map run's reading time is not estimated: only its tokens, as today |
| Held now | **new:** on Windows, each file the run will replace (the repos' facts and rejected files, their stored reads, `build.json`) is opened for writing and closed, with no byte written. A file that can't be opened is listed. Read-only, one pass, no wait                                                                                                                                                                                                                                                                      |
| Versions | `standing(root, { quick: true })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Undo     | `UNDO_KEEP` against the Builds count, and `listUndo` for what is kept now                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

One function makes all six, `runPlan(root, action, repos)` in a new `packages/cli/src/run-plan.ts`, used by the command line and by the routes. Its `plan` value is a hash of the action and the sorted repo list.

**What is refused, and its way on.**

- A newer catalog, a metarepo not upgraded, no facts at all: refused before any plan, with the one command they have today (`verify-commands.ts:306`, `standing.ts`). The question is never asked on top of a refusal.
- In the app, a Start whose `plan` no longer matches the repos on file (a repo was read or removed meanwhile) is a 409, "The list changed: read it again", and the panel reloads. A Start with no `plan` is a 400. This is `ui-api-apply-plan.test.ts`'s rule for a confirm, applied to a start.
- A held file refuses nothing. The run may start; the row says what will happen.

**Routes (C4, additive).** `GET /api/facts/apply-all/plan?repos=a,b` and `GET /api/copilot-runs/plan` return `Api.RunPlan` (`repos`, `leftOut`, `builds`, `estimateMs?`, `timed`, `held?`, `standing`, `undo: { keeps, builds }`, `plan`). `POST /api/facts/apply-all` and `POST /api/copilot-runs` take `plan`.

### 2. Three more map tools (item 21)

Each is one entry in `MCP_TOOLS`, read-only, with `--json`, beside `conflicts`.

| Tool              | Argument                         | Runs                                                | Answers                                                                                                                                                                                                             |
| ----------------- | -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owners`          | `id`: a record, a repo, a system | `atticus owners <id> --json` (new)                  | the owner, and where it is said: the System record's id, or the manifest or profile file. "no owner on record" when none names one. The record's id and its system's id are in every answer                         |
| `consumers_of`    | `id`: a topic, an API, a repo    | `atticus impact <id> --receivers --json` (new flag) | for a topic, the components that receive it, and what lies past them apart (`receiversOfAll`); for an API or a component, the interfaces whose callee it is, with each caller. Each row has its record id and owner |
| `similar_changes` | `change`, or `text`              | `atticus change similar [--change <id>] --json`     | the archived changes nearest it, best first, each with its archive folder, its change id, its file, and whether by meaning or by words. It lists archived changes; open ones that overlap are `conflicts`' answer   |

- **An id the map lacks** is an answer for `owners` and `consumers_of`, by the rule the tools have (`mapId`, `mcp.ts:527`): which of the three it is, in the manifests and not read, planned by an open change, or neither, with the nearest ids. A manifest repo nobody read still has its manifest's owner, and `owners` gives it with "not read". A map that couldn't be read is an error that says what is wrong (`mapFault`).
- **Nothing found** is an answer: "Nothing in the map receives <id>." (`index-commands.ts:253`), "No archived change is near this one yet (or none is archived)." (`similar-changes.ts:231`).
- **Refused, as an error result:** `similar_changes` with a change id that is no change ("There is no change <id>: atticus change list shows them.", `:217`), and with neither argument.
- `ask "who owns <id>"` answers what `owners` answers, so the two can't differ.
- The starter personas' `tools` lists gain the three. An org pack that already has the starters keeps its files (ADR 0201: never over a file that is there); the guide page "The map your personas ask" gives the three lines to add. Copilot's files name `atticus/*` already.

### 3. A quick change moves to the stages (item 23)

```
atticus change move <id> --to staged [--type feature] [--plan] [--yes]
atticus change move <id> --to quick
```

**What the person sees.** The command lists what it will do, asks once ("Move <id> to the stages? [y/N]", by section 1's rule: `--yes` for a script, `--plan` to look only), then says:

```
Moved publish-settled-refunds to the stages (type feature). It is in define.
  brief.md was written from requirements.md.
  Kept as evidence the stages read, in inputs/: quick-proposal.md, quick-design.md (with its In the code table), quick-tasks.md, quick-spec-settled-refunds.md.
Next: atticus change feature publish-settled-refunds
Back: atticus change move publish-settled-refunds --to quick, until a stage has run.
```

In the app, a quick change before build has **Move to the stages** on its Work page: a panel with the same list, the type to move to, and Move. `POST /api/changes/{id}/move` with `{ to, type? }`; `GET` of the same path gives the list.

**What it does,** with no model:

1. `requirements.md` stays where it is. Its text, whole, becomes `brief.md` under one line that says where it came from. The staged types require a brief, and the feature stage starts from it.
2. `proposal.md`, `design.md`, `tasks.md` and each spec delta are attached to the change through `attachFiles`, as `inputs/quick-…`, and taken out of the folder's root. They must leave the root: a person's `tasks.md` there reads as the stories stage already done (`progress.ts:50`), and the stages write those four files themselves.
3. **The `## In the code` table is kept as evidence,** in `inputs/quick-design.md`. The stages read it as data, cited by line. It is not turned into target flows or operations: a row says what a repo will have, not which step of which flow changes, and guessing that is the stage's work. One net keeps a row from being lost: once the architecture stage is done, each row that no target flow step and no operation covers is a note, `delta.quick-row-not-carried`, with the row and its line, shown in `change status` and in the design hand-off's PR. A note, never a refusal.
4. In `change.yaml` the `type` becomes the staged type and the `state` its first phase, with one `history` entry whose `reason` says "Moved from the quick path (type quick)." No key is added.

`atticus next <id>` then offers the feature stage, because the type is no longer quick.

**What is refused,** each with its way on, and nothing written:

| Refused when                                                                                           | The line says                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| the change's type is not quick                                                                         | "<id> is on the stages already (type <type>): atticus next <id>"                                                                   |
| it is in build or later                                                                                | "<id> is past its plan hand-off, so code may be built against its design. Start a new change for what is left: atticus change new" |
| a hand-off PR is open                                                                                  | "Its plan hand-off is open (#<n>). Merge it, or return it first: atticus change return <id> --reason … --approve"                  |
| the type given is quick, small or has no `stories`, or none is given and the org pack has no `feature` | "<type> has no stages. Types that do: <list>."                                                                                     |
| `brief.md` is there with other text, or an `inputs/quick-…` name is taken                              | "<file> is there already: move it away or rename it, then run this again."                                                         |
| a file to move is held (Windows)                                                                       | section 1's words; nothing is moved                                                                                                |

A quick change with files missing or questions still open may move: what is there is carried.

**Reversible, until a stage runs.** `--to quick` puts the four files back from `inputs/`, removes the `brief.md` the move wrote (only if its bytes are still the move's), sets the type back and adds a second history entry. It is refused once any stage's loop file exists (`packages/changes/src/lifecycle.ts:119`): "A stage has run for <id>. Its quick files are in inputs/ as evidence; the move can't be taken back." Nothing is ever deleted either way; the metarepo is in Git.

### 4. A planned topic carries its schema and settings (item 26)

A publish step whose target is new may say what the topic is, as a new table does:

```yaml
- op: add
  kind: publish
  what: Publish the shipped order.
  to: { component: forge-hub, entry: forge.orders.shipped, new: true }
  fields: { sends: [orderId, shippedAt] }
  topic:
    format: json # json | avro | protobuf | other
    schemaFile: schemas/forge.orders.shipped.json # optional: the file in this repo that will hold it
    key: orderId # optional
    fields: { orderId: string, shippedAt: timestamp }
    classification: { orderId: internal } # optional, the org pack's levels
    settings: { partitions: "6", retention: 7d, deadLetter: forge.orders.shipped.dlq } # optional, free keys
```

**What the person sees.** The architecture prompt asks for it on a new topic. `design.md` gains a table, "Topics this change adds": topic, publisher, format, key, fields with types and classification, settings, and who listens (each with its standing: read, not read, planned, outside). The publisher's task gets one criterion for the schema file and one for the settings. A listener's task names the fields it may read.

**What is checked,** in the architecture stage and again in stories, with no model:

| Rule                         | When                                                                                                        | Blocks                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| `delta.topic-fields`         | the step sends a field `topic.fields` lacks, or a flow this change adds that listens to the topic reads one | yes                     |
| `delta.topic-exists`         | `topic` is given and the map has the topic: "the map has <id>: take `topic` off; its fields are the map's"  | yes                     |
| `delta.topic-twice`          | two steps of the change define the same topic differently                                                   | yes                     |
| `delta.topic-classification` | a level the org pack doesn't have, as a table's is checked                                                  | yes                     |
| `delta.topic-secret`         | a setting's value has a secret's shape (`hasSecretShape`); the value is never printed                       | yes                     |
| `delta.topic-no-schema`      | a publish to a new topic with no `topic`, or one with neither `fields` nor `schemaFile`                     | no: a note (question 4) |

After the build, `schemaFile` is looked for in the commit's tree as a pipeline's file is (ADR 0206), with the same outcomes.

**The contract.** `topic` is one optional key on a delta step; the flow delta stays version 2, as its other additions did (`schema.ts:245`, `:369`). A change drafted before has none and reads as it did; the only new finding it can get is the note.

## Contracts and version bumps

| Contract                    | Change                                                                                                                                                    | Bump                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C4, the map tools           | `owners`, `consumers_of`, `similar_changes`                                                                                                               | None (additive)     |
| C4, the command line        | `--plan` and `--yes` on `map --all` and `verify --all`; `atticus owners`; `atticus impact --receivers`; `atticus change move`. The surface census changes | None (additive)     |
| C4, the local API           | Two plan routes, `plan` on two start requests, the move's two routes, optional `quickRowsNotCarried` on a change's status                                 | 3.19.0, as it is    |
| `change.yaml`               | No key. A moved change has another `type`, another `state` and one more `history` entry, all in today's shape                                             | None; version 1     |
| Stage files (the planner's) | A delta step's optional `topic`                                                                                                                           | None; delta stays 2 |
| C1, C2, C3, C5, C6, facts   | None. The new `delta.*` rules are the planner's stage checks, as ADR 0203's are; no rule pack changes. No change type is added                            | None                |
| Not contracts               | `.atticus/timings.json`, local, version 1, rebuilt by use; a file that doesn't read is no timings                                                         | None                |

## Migration

None is needed. An older Atticus reads a moved `change.yaml` (same keys). It refuses a flow delta that has `topic` (the delta is strict, `schema.ts:404`), as it refuses ADR 0203's keys; a metarepo is upgraded as a whole.

**The beta.28.5 upgrade test** (`packages/cli/test/upgrade-b30.test.ts`) gains: after `atticus upgrade`, the change done through stories, whose delta publishes to a new topic with no `topic`, is byte for byte the same, each stage reads as done with no model call, and its only new finding is the note; `change.yaml` of every change parses with the beta.28.5 schema kept in the test folder; `verify --all --plan` on the upgraded metarepo says "No estimate yet" and writes nothing.

## Tests that prove it (written first, failing)

All on invented Forge names, with the mock model and no network.

- **The field-shaped estate** (`fixtures/forge-field`, `packages/cli/test/field-estate.ts`) gains, as shapes before their code: one archived change (its archive is empty today), a repo whose owner only the manifest names and one nobody names, a topic with two listeners, and a staged change that publishes to a new topic. Regenerated with `pnpm fixtures:field`.
- `cli/test/run-plan.test.ts`, on the field estate: the six rows for 40 repos; the estimate from a made timings file, with some repos untimed, and with none; the undo row at 5 or fewer builds and above; `--plan` writes nothing (every file hashed before and after); `--yes` starts; a fake `ask` answering no starts nothing; with no `ask`, with `--json` and with `CI` the output is today's bytes; the held row with `fsHooks.platform = "win32"` and, in the Windows job, with a file a second process really holds.
- `cli/test/ui-api-run-plan.test.ts`: the route's body equals `--plan --json`; a Start with a stale `plan` is 409, without one 400; nothing starts on either.
- `cli/test/mcp.test.ts`: each new tool on the field estate: an answer with record ids; an id not read, planned, and neither; no owner; nothing receives; no archived change; the unknown change as an error. `ask "who owns"` equals `owners`.
- `cli/test/archetypes.test.ts`: the field estate's quick change, `publish-settled-refunds`, moved to the stages and run to the end of stories with the mock model; the table's row no flow covers is the note; moved back before a stage is byte for byte the folder it was; each refusal of the table above with its line. The new event's staged change carries `topic`, and `design.md`'s table is a golden file.
- `planner/test/topic.test.ts`: each `delta.topic-*` rule by name; a golden `design.md` and tasks.
- Journeys: the panel and the move in the app, with their empty, loading and error states and axe checks.

## What it does NOT do

- It does not make a run over many repos undoable as a whole. It says how far undo reaches (question 2).
- It does not estimate a map run's reading time, or promise the estimate: it is the last run's time on this machine, said as "about".
- It does not lock a file it found free: another program can take it a second later, and the write's own wait still applies.
- It asks nothing in an assistant's session, a script or the app's job.
- The tools write nothing and call no model. `similar_changes` is a hint where to look, not a fact; `consumers_of` knows only what was read into the map.
- The move does not turn the quick files into stage files, run a stage, or carry a change that is in build. It does not carry the plan gate's critic rounds forward as passed: the stages' gates run as for any staged change.
- A topic's settings are not checked against the code or a broker: Atticus never connects to a live system (rule 6). On the quick path a topic's schema stays in the spec delta's words; the `## In the code` table gains no new word.

## Rough size

About 1,300 lines that aren't tests.

| Part                                                                                      | Lines |
| ----------------------------------------------------------------------------------------- | ----- |
| 1. `runPlan`, the timings file, the held check, the question and flags, routes, the panel | 500   |
| 2. `atticus owners`, `impact --receivers`, three tool entries, starters and guide         | 150   |
| 3. The move and its way back, the net's note, the command, routes, the app's action       | 420   |
| 4. `topic` on a step, six rules, the design table, task criteria, the prompt's lines      | 230   |

## Risks

- **The estimate will be wrong after a big change to a repo,** and on a machine under load. It says where it comes from and how many repos had no time.
- **The held check can itself be refused** by a virus scanner for a moment and list a file nobody holds. It only informs; it never refuses.
- **A question before a long run is one more step.** `--yes` and the app's one click are the way past; scripts see no change.
- **The move leaves the quick design as evidence only.** The first stage draft may differ from what the personas wrote. The note for uncovered rows is the net; a person reads the draft, as on any staged change.
- **The architecture prompt gains lines,** so its hash changes and the recorded replays are re-baselined once more.
- **Existing persona files don't gain the new tools** in Claude Code until a person adds three lines.
- **Not verified:** no code was run. The Builds count for `map --all` (one for each part read, then the join) is from the command's own description (`map-all.ts:68` to `:82`), not traced through the loop. Whether `design.md`'s new table needs a line in the org-flow design template (as ADR 0203's Operations did) was not traced; if it does, it rides in org-flow 3, which beta.30 has not released. Whether the critic's rounds at a quick change's plan gate show oddly on a change moved back to `define` was not read. Whether opening a file for writing on Windows fails for every kind of hold the write itself meets is for the Windows job to say.

## Also in beta.30, with no ADR

**The property nightly on Windows too (item 3).** `.github/workflows/properties-nightly.yml` runs on `ubuntu-24.04` only (`:34`; its comment says "Linux only", `:6`). It gains `windows-latest` in a matrix, with fewer sequences if the runner needs it, and a slow-disk case: the harness's fault model (`packages/cli/test/properties/fault.ts`) gains a fault that delays every rename and write through `fsHooks` (`fs.ts:181`), and one where a second process really holds a file of the facts folder. No job with a file really held was found in the workflows today, though step 1 of [the plan](../plan/v30.md) lists one. Tests and a workflow only; no product code.

## Questions for the owner

1. **From how many repos is the question asked?** Recommended: two or more, for a run that writes (`map --all`, `verify --all --write`, Apply to several repos in the app), and never for `verify --all` without `--write`. Five (the app's "many" today) would leave a three-repo run on a slow estate unannounced, and the answer is one key.
2. **Undo for a whole run: say how far it reaches, or make it reach?** Recommended: say it in beta.30. One undo copy for a whole run changes what ADR 0195's guards and `catalog undo` mean, and belongs in an ADR of its own with its property tests. The plan's row tells the person to commit first, which works today.
3. **Should the move turn the table's operation rows (deployment, route, config, secret, pipeline, cut-over) into a first `_operations.yaml`?** Recommended: no. Kept as evidence, with the note for any row the stages didn't carry. A seeded file would read as a person's draft (ADR 0203 B.1) with no waves and no `after`, and the architecture stage would have to mend it.
4. **A new topic with no schema: a note, or a blocking finding a person may accept?** Recommended: a note in beta.30, listed in the design hand-off's PR. Blocking would fail the re-check of every staged change already drafted with a new topic, which the upgrade test forbids; it can become blocking and acceptable (ADR 0203 A) once field use shows the prompt fills it.
