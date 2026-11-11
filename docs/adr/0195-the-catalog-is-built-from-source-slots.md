# 0195. The catalog is built from source slots: a scan or a verify writes only its repo's observation, and one pure build makes catalog/generated

- Status: proposed (the design settled in the beta.27 planning session, 2026-11-11; for the product owner to accept)
- Date: 2026-11-11
- Release: 2.0.0-beta.27
- Amends: ADR 0003 (`catalog/generated/` is written only by the build, not "only by scans"), ADR 0124 addendum A3b ("What --write does": `--write` no longer patches the catalog it finds; its "Not done here" question, which source wins for a repo that has facts, is answered in point 2) and addendum A-incremental (the scan's own `factsForScan` carry becomes the write step `verify --write` already runs, point 1)
- Builds on: ADR 0010 (the scan runner and its cache), 0017 (merge identity), 0026 (curated decisions), 0031 (features from code), 0038 (federation), 0039 (the glossary), 0051 (upgrade and migrate), 0074 (results stored per commit), 0123 (branches), 0124 (facts, the verifier, the estate join), 0135 (why a link is there), 0151 (contract files and traffic), 0160 (another team's map), 0163 (terms), 0181 (the AI's targets), 0187 (the Console), 0190 (edit then propose)
- Contracts: no schema change to C1, C2, C3, C5, C6 or the facts file (`FACTS_SCHEMA_VERSION` stays 5). C4 gains additive routes for the cross-check view (ticket CS3; a minor version, numbered when it lands). New formats, not contracts, versioned here: the readers slot (`slotVersion: 1`), the facts slot (`slotVersion: 1`) and the cross-check's dismissals (`version: 1`). `atticus scan --json` loses `kept`.

## Context

In beta.25 and beta.26 `atticus scan` (the built-in readers, "check with the built-in readers") rewrote `catalog/generated/` with only what that run read. `writeCatalog` (`packages/scanner/src/files.ts:110-141`) removes every record file not in the set it is given, so a scan deleted the records of every repo it did not read: a repo not cloned on this machine, a repo outside `--repos`, a repo whose reader failed, and every record that `atticus verify <repo> --write` had projected from verified facts.

Two fixes tried to carry what the scan did not read into the next merge. Both failed review, for reasons that are the same reason:

- Curated decisions were undone: the carried records had already been through `applyCurated`, and were restored after it ran again.
- A cross-repo arrow whose caller had gone came back, because the carried Interface was derived output and nothing re-derived it.
- In `mergeCatalog`'s combine, a carried scalar value beat the fresh one.
- Records were duplicated when the facts join resolved a call differently from the carried record.
- A fuzzy de-duplication of reader records against fact records dropped real findings.
- A failed extractor run still deleted.

beta.26 ships a safety stop (the scan writes nothing unless every production repo was read in full) and fixes `verify --write` rewriting the facts file after a refusal. The stop prevents the loss; it also makes a scan with one repo missing do nothing at all.

The code shows why carrying cannot be made to work. Six paths write `catalog/generated/`, each with its own set of passes:

| Writer               | Where                                                                                       | What it does                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scan                 | `packages/scanner/src/scan.ts` → `writeCatalog` (`packages/cli/src/scan-commands.ts`)       | Readers per repo, merge, joins of the repos it read, curated. No link evidence, shared maps, term grants, a person's pairs or the AI's targets.                                                              |
| `verify --write`     | `writeFactsIntoCatalog` → `catalogWithFacts` (`packages/scanner/src/facts-catalog.ts:1440`) | Incremental on the catalog it finds (`existing`): drops the repo's records, projects, re-merges, and runs `applyCurated` again over an already curated catalog. No features, glossary, intake or federation. |
| Glossary scan        | `packages/glossary/src/scan.ts`                                                             | Patches `GlossaryTerm` and Column files in place.                                                                                                                                                            |
| Branch scan          | `packages/cli/src/branch-scan-commands.ts`                                                  | Its own carry of other repos' records (`others`) into `catalog/branches/<branch>/generated/`.                                                                                                                |
| The learning sandbox | `packages/learn/src/engine.ts:114`                                                          | A scan written straight in.                                                                                                                                                                                  |
| Repo rename, upgrade | `packages/cli/src/repo-rename.ts:201`, `packages/cli/src/upgrade.ts:449`                    | Rewrite record files in place.                                                                                                                                                                               |

So the comment in `packages/scanner/src/merge-input.ts` that a catalog "never depends on which of them wrote it last" is false today. Each writer is a patch on derived output, and the last one wins.

There is a seam to build on. The records a scan's readers produce for a repo (`readerRecords`, after `scanRepo`, `packages/scanner/src/scan.ts` around line 561) are self-contained per repo: every evidence entry is stamped with `evidence.repo`. `facts/<repo>.jsonl` is per repo. Everything after the pipeline's models is cross-repo: the joins in `mergeCatalog` and `applyFactJoins`. The per-commit cache under `.index/scan-cache/<repo>/<commit>/<extractor>@<version>.<hash>.json` already holds per-repo results, but it is local and git-ignored, so a second person's scan cannot use it. Curated decisions are `catalog/curated/curateddecision/<id>.yaml`, each keyed by the id of the record it targets. 88 test files seed `catalog/generated/` from `fixtures/forge/expected/scan.yaml`, which is a readers-only catalog.

### How others solve it

- **Backstage entity providers.** Each provider owns its own bucket of entities. A full mutation replaces only that bucket, keyed by `locationKey`. A processing error keeps the last good entity. Stitching recomputes relations from all buckets. Incremental providers remove entities only after a complete read. `rejectEmptySourceCollections` and `rejectRemovalsAbovePercentage` guard against a bad read.
- **Kubernetes server-side apply.** `managedFields` records which manager owns which field, so one writer never silently takes another's.
- **Terraform.** Data sources are read-only inputs. `-target` is known to cause drift because it plans with part of the state.
- **Salsa, Bazel, stack graphs.** Derived results are recomputed from stored per-input results. Nobody patches derived output.
- **dbt.** Staging models per source, deterministic models built on them, and `hard_deletes` that are explicit.
- **Event-sourced read models.** A read model is rebuilt from the log, never edited.
- **Sourcegraph.** Precise code intelligence is uploaded per repo and per commit. Cross-repo links are resolved at query time, with a fallback to an older upload.
- **Feldera and fast-check.** Differential testing (incremental against from scratch) and model-based testing (`fc.commands`).

They agree: keep each source's last good observation, and recompute everything derived from all of them.

## Decision

### 1. Source slots, committed in the metarepo

Each repo has up to two **slots**: what was last observed of it, by the readers and by the assistant's verified facts. They are committed in the metarepo beside the catalog, and reviewed in the same catalog PR.

| Slot    | Path                                                                              | Written by                                                                                    |
| ------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Readers | `catalog/sources/readers/<repo>.json`                                             | A scan that read the repo in full, at a known commit                                          |
| Facts   | `catalog/sources/facts/<repo>.jsonl` and `catalog/sources/facts/<repo>.meta.json` | `atticus verify <repo> --write` when it succeeds (nothing rejected), and the scan's same step |

**The readers slot** is one canonical JSON file (keys in a fixed order, two-space indent, LF, one trailing newline):

| Field         | Holds                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slotVersion` | `1`                                                                                                                                                                   |
| `kind`        | `readers`                                                                                                                                                             |
| `repo`        | The manifest's repo id                                                                                                                                                |
| `commit`      | The commit the readers read                                                                                                                                           |
| `status`      | `read` (a full read) or `legacy` (adopted by `atticus upgrade`, point 6). There is no `partial`: a partial read writes nothing.                                       |
| `extractors`  | Each extractor that ran, `{ id, version }`, sorted                                                                                                                    |
| `settings`    | A hash of what steered the readers: the repo's scan settings, the rule files and the plugins with their pins                                                          |
| `records`     | The repo's C1 records as the readers produced them, before the merge (`readerRecords`), each in C1's own shape at its own `schemaVersion`, sorted by kind and then id |

No time is written, so an unchanged repo scanned again writes the same bytes and the slot does not change.

**The facts slot** is a snapshot, not the live file. `facts/<repo>.jsonl` stays the assistant's working file: verify reads it on every batch, and a half-finished read lives there. The snapshot is copied from it only when `verify --write` succeeds, so a read that is not finished never reaches the catalog. `<repo>.jsonl` holds the kept facts as verify writes them (sorted by id, canonical). `<repo>.meta.json` holds what is needed to project them without the clone:

- `slotVersion`, `kind: facts`, `repo`, and `commit`.
- `factsSchemaVersion`.
- `factsHash`: the SHA-256 of the snapshot's bytes.
- `contracts`: the repo's `<repo>.contracts.yaml` as read at that commit, or `null`. ADR 0151 reads it at the facts' commit, so the snapshot keeps it.

Answers, a person's pairs, the AI's targets, traffic, shared maps and the org pack are build inputs (point 2). They are not copied into the slot.

**Failure is no observation.** A run replaces a repo's slot only when it observed the whole repo. For the readers that means:

- the base clone is there at a known commit;
- the repo is in the run's set (`--repos`);
- every extractor the repo's profile selects ran to the end without an error or a timeout;
- no plugin was refused by its sandbox;
- the run was not cancelled.

Anything less writes nothing for that repo. The slot keeps its last good content, with the commit it was read at, so staleness shows (point 5), and the scan says which repo kept its last read and why. The scan still writes the slots of the repos it did read in full. This replaces beta.26's all-or-nothing stop.

For a repo with a facts snapshot, the scan runs the step `verify --write` runs (ADR 0124 A-incremental: carry the facts whose files did not change, verify, snapshot only when nothing is rejected). It does not run its own `factsForScan` merge. When a file a fact cites changed, the snapshot stays where it is, marked by its commit, and the scan's note says to re-read the repo. There is one facts writer, whoever calls it.

### 2. One pure build

```
catalog/generated = build(slots, org pack, answers, pairs, AI targets, contracts, traffic,
                          shared maps, inputs, federation, curated)
```

`buildCatalog` (`packages/scanner/src/build.ts`) is pure: it reads no clone and calls no model, adapter or network. Whatever a pass got from a model or an adapter is already a file in the metarepo before the build runs, such as a glossary definition the model completed or a wiki page a sync fetched. `writeBuiltCatalog` is its IO half, and the only caller of `writeCatalog`.

The build runs in a fixed order, from complete inputs, every time:

1. **Per repo, one source.** The facts slot when it is current, projected with `projectFacts`. Otherwise the readers slot (`read` or `legacy`). Otherwise nothing, and the repo is only what the manifests say of it, as today.
   - _Current_ means the snapshot and its meta parse, its versions are supported, `factsHash` matches and the manifests still list the repo. A snapshot that fails this is reported and not used.
   - Current does not mean "at HEAD". A facts slot behind the clone still wins over a newer readers slot: the readers become the cross-check (point 3), never the source, for a repo with facts.
   - The choice is by repo and deterministic. Reader records are never matched against fact records to drop "the same" one.
2. **The merge** of every repo's records with the intake records of `inputs/` and the federated catalogs (`mergeEstate`, `mergeCatalog`), as a full scan does today.
3. **The joins**, recomputed over every facts slot at once: `joinFacts` and `applyFactJoins` with the answers, the pairs and the AI's targets; the term grants (`joinTerms`); the shared maps (`joinSharedMaps`); and the link evidence of the contract files and traffic (`linkEvidenceOf`). The estate join is computed once for the estate, not once per written repo, so there is nothing to take off before putting back.
4. **The curated decisions**, applied once as the last overlay (`applyCurated`), keyed by the stable record ids they target. A decision whose target is not in the build is reported as orphaned and kept in `catalog/curated/`, so it applies again when its target returns. Link evidence moves before curation (`catalogWithFacts` applied it after), so a person's suppress always wins.
5. **The passes that read the curated catalog**: features (ADR 0031), then the glossary's terms (ADR 0039).
6. **The guards, then the write** (point 4).

No derived output is ever carried. Nothing the build wrote is ever read back as an input to the next build. Every writer becomes "update my slot, then build":

| Writer               | Becomes                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atticus scan`       | Writes the readers slot of each repo read in full (and the facts step of point 1), then builds.                                                                                                                                  |
| `verify --write`     | Writes the facts snapshot when the run succeeds, then builds. The incremental patch on `existing` and the second `applyCurated` are deleted.                                                                                     |
| Glossary scan        | Writes the glossary's own inputs, then builds. It never patches record files.                                                                                                                                                    |
| Branch scan          | Writes `catalog/branches/<branch>/sources/readers/<repo>.json` for the branch's repos, then builds the branch's catalog from the baseline's slots with the branch's slots in place of its repos'. The `others` carry is deleted. |
| The learning sandbox | Writes the sandbox's slots, then builds.                                                                                                                                                                                         |
| Repo rename, upgrade | Rename moves the repo's slot files and rewrites the repo id inside them (and the curated targets, as now), then builds. Upgrade migrates slots step by step (ADR 0051), then builds. Neither edits `catalog/generated/`.         |

`atticus catalog build` builds on demand, after a curated file is edited by hand or a merge conflict. `--check` writes nothing and exits non-zero when `catalog/generated/` is not what the slots build, which a metarepo's CI can run. The command, the app and the editors take the scan's lock. A crash between a slot write and the build leaves the catalog behind but whole (each record file is written atomically), and the next build catches it up. A conflict in `catalog/generated/` after a git merge is always resolved by building again, never by hand. A conflict in a slot is resolved by keeping either side (normally the later commit) and building.

`merge-input.ts`'s comment becomes true, and its tests prove it (point 9).

### 3. Readers where facts exist: a cross-check, never a silent merge

For a repo with a current facts slot, the build compares the readers slot with the facts projection and reports three lists. Records are matched by their C1 id, and by the kind's key where ids can differ: an Interface's caller, method and normalised path; a Table's name; a Column's `table.column`; a Setting's key. Nothing is matched fuzzily.

- **Readers found, the facts don't have it**: with the reader's evidence (file and line at the readers slot's commit).
- **They disagree**: the same record with a different value (a method, a path, an operation, a type), both values shown.
- **The facts have it, the readers don't**: a count, for information. The readers are known to miss things.

Map › Trust shows this per repo as the readers' cross-check. A "readers found" item has two actions:

- **Promote to assert.** The person checks the cited line, and Atticus writes a `by: person` fact with the reader's citation into `facts/<repo>.jsonl` as an edit to propose (ADR 0190). It reaches the catalog through the next successful `verify --write`, so the verifier checks the claim on its line like any other fact.
- **Dismiss.** The dismissal is kept in `facts/<repo>.crosscheck.yaml` (`version: 1`, the item's key and the readers' value). A dismissed item is listed again only when the readers' value changes.

Nothing in the cross-check changes the catalog by itself.

### 4. Guards

- **No empty catalog over a full one.** The build refuses to write a catalog with no records over one that has records, unless the manifests list no repo. It says why and writes nothing.
- **Removals are said.** Every build reports the records it removes, by the repo of their evidence. Removing more than 10% of a repo's records, or more than 200 records in one build, is a warning in the command's output, the Console (ADR 0187) and the catalog PR's description, with the list. The limits are built in, not org-pack settings, because a setting would be a C6 change. Backstage's `rejectRemovalsAbovePercentage` refuses; this only reports, because the slots already make a lost read impossible and a large removal here is a real change of the code or the inputs.
- **Slots of repos the manifests no longer list** are not built from, and are reported as orphaned. Rename moves them. An archived repo's slots stay on disk and are left out.

### 5. Staleness shows

A slot's commit is compared with the base clone's HEAD wherever the clone is there: the scan, `verify`, `atticus next`, Set up › Repos and Map › Trust. The build itself compares nothing; it reports each repo's source and commit (`facts at <commit>`, `readers at <commit>`, `legacy`, `none`). A repo whose slot is behind is shown as read at that commit, never as current and never as gone.

### 6. Upgrading a metarepo: legacy slots, once

An `atticus upgrade` step runs once, when `catalog/sources/` does not exist and `catalog/generated/` has records:

- Records whose evidence names one repo go into that repo's readers slot with `status: legacy`, and with the commit the last scan recorded for the repo, else `unknown`.
- Records with evidence from several repos (joined Interfaces) are not adopted. The build derives them again where its inputs allow, and the upgrade's report lists those it cannot derive yet.
- For a repo whose `<repo>.verify.yaml` records a passing verify of the facts file as it is now (its hash matches), the step also takes the facts snapshot from that file. Otherwise the repo's assistant records stay in its legacy slot.
- The step then builds, and reports the difference from the catalog it adopted.

A legacy slot is labelled as such in Map › Trust and Set up › Repos, with "scan or verify this repo to replace it". The first build is never empty. The step is idempotent: once `catalog/sources/` exists it does nothing.

The fixtures ship golden slots in `fixtures/forge/slots/`, generated by a script from `fixtures/forge/repos/`. They are golden files of the readers' output, reviewed as such. `fixtures/forge/expected/scan.yaml` stays hand-written and stays the oracle: a golden test asserts that building the golden slots with the Forge org pack gives that catalog.

### 7. Determinism, and the per-commit rule

The same slots, org pack, answers and other inputs give the same bytes, on Linux and Windows. Slots are the stored per-commit results of CLAUDE.md rule 4: the same commit with the same org pack and answers returns the same stored catalog, because the slot of that commit is the stored result and the build is a function of it. A changed file still invalidates only the facts that cite it, through verify's carry. Building again with nothing changed writes no file.

### 8. Performance

- Each slot's projection (the facts projected, or the readers' records read and checked) is cached by the hash of its bytes and the build's version in `.index/build-cache/`. The cache is local, git-ignored and never needed for a correct result: a build without it gives the same bytes, and the property tests check that (the differential test of point 9).
- The merge, the joins and the overlay run every build. The budgets below are for an estate of 40 repos, with up to about 2,500 records and 12,000 facts in a repo. They are measured on a synthetic estate (`packages/synth`) in CI and move only with numbers:
  - one slot changed, the others cached: under 15 seconds;
  - a cold build: under 90 seconds;
  - the heap: under 1.5 GB;
  - an unchanged build: no file touched.

### 9. Testing

Model-based property tests with fast-check (`fc.commands`, a dev dependency under the licence check) run against a temporary metarepo whose readers are the mock reader adapter (CLAUDE.md rule 5).

- **The model** is small: for each repo, its readers slot, its facts slot and its live facts file, plus the curated decisions and the answers.
- **The commands**: scan (read in full; not cloned; a reader fails; cut short; outside `--repos`), `verify --write` (succeeds, refused), a live facts edit without `--write`, a curated decision (alias, assert, suppress) added or removed, an answer given, a repo renamed, removed or archived, and `atticus upgrade`.

| Invariant                       | Holds after any sequence of commands                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Equivalence (the master oracle) | The catalog is byte-identical to a full build of a fresh metarepo given only the final slots and inputs, with and without the build cache.              |
| Locality                        | A change to one repo's slot changes only records with that repo's evidence, or derived from a join that involves it.                                    |
| Idempotence                     | Building twice, or scanning an unchanged repo, changes no byte.                                                                                         |
| Order independence              | Scans and writes of different repos in any order give the same bytes.                                                                                   |
| Failure neutrality              | A failed, partial, cut-short or out-of-set run leaves that repo's slot and the whole catalog byte-identical.                                            |
| Readers never destroy facts     | For a repo with a current facts slot, no change to its readers slot changes a field of a record projected from its facts.                               |
| Curation survives               | A curated decision's effect is in the catalog whenever its target is. When the target is gone, the decision is reported orphaned and kept, not dropped. |
| Links are live                  | Every cross-repo Interface follows from the current slots and inputs. No arrow outlives its caller or its callee.                                       |
| No silent loss                  | Every record removed between two builds is in the build's removal report, explained by a changed slot or input.                                         |

Each invariant also has a hand-written example test. Failing seeds are printed and replayed. `pnpm check` runs 100 sequences, and a nightly job runs 2,000. The golden tests (the Forge slots to `expected/scan.yaml`; ADR 0124's three repos in any order) and the journeys (ticket CS5) sit on top.

## Consequences

- A scan can no longer delete what it did not read. A repo that is not cloned, outside `--repos`, or whose reader failed keeps its last good read, and says so. A scan with one failing repo still records the others, which beta.26's stop did not allow.
- `verify --write` and a scan can no longer undo each other. For a repo with facts, the facts are the source and the readers are the cross-check, which ADR 0124 §3 promised and the merge never kept.
- Curated decisions are applied once, last, and can no longer be undone by carried records. Stale arrows cannot come back, because nothing derived is carried.
- The metarepo gets `catalog/sources/`, about as large again as `catalog/generated/`. A catalog PR shows each slot that changed, then the derived records that changed with it. Slots are per repo, so two people scanning different repos do not conflict.
- `catalog/generated/` stays C1, committed, and is what every consumer reads: the index, the critic, the planner, the API, the app, the editors and the bench. None of them changes. It becomes purely derived, so a hand edit to it is overwritten, as it always could be.
- The `kept` field of `atticus scan --json`, which summarised the carried records, goes away. Nothing is carried. `--json` gains `sources` (per repo: `{ repo, source: facts|readers|legacy|none, commit, slot: written|unchanged|kept-last-good|none, reason? }`) and `removed`.
- `.index/scan-cache/` (ADR 0010) stays as it is: a local speed-up for the readers, below the slots.
- The 88 test files that seed `catalog/generated/` from `expected/scan.yaml` split in two. Tests that only read the catalog may keep seeding it, because it is still C1. Tests that run a writer seed slots instead (ticket CS5).
- Writing a slot and building are one locked operation. The lock is held longer than a scan's write was, by the build's time (point 8).

## Alternatives considered

- **Carry derived output into the next merge** (the two beta.26 attempts). Rejected for the failures listed in the context: each one patches output that a later pass has already transformed. That is the bug Salsa, Bazel and event sourcing avoid by never patching derived results.
- **Keep beta.26's stop as the design.** Safe, but a scan with one repo missing does nothing. It also leaves the six writers with six pass sets, so the catalog still depends on which wrote last.
- **Per repo, the newest source wins** (readers newer than the facts replace them). Rejected: a routine scan would flip a repo from facts to readers and back, which is the beta.25 loss in another form.
- **Merge readers and facts record by record, with fuzzy de-duplication.** Tried, and it dropped real findings. The cross-check (point 3) shows the same differences to a person, with nothing dropped.
- **Field ownership in each record, as Kubernetes' `managedFields` does.** It would change C1 (rule 1) for every consumer, and it is still a patch on derived output.
- **Make `.index/scan-cache/` the source.** It is local and git-ignored, so the next person's machine has none of it, and their scan would delete again. Slots are the same idea, committed.
- **An event log of every scan and write, with the catalog rebuilt from it.** Correct, but the log grows without end, and the catalog needs only the latest observation of each source. Slots are that log compacted to its last entry per source.
- **Resolve cross-repo links at query time, as Sourcegraph does.** Every C1 consumer would have to join at read time. Building once and writing C1 keeps the consumers as they are.
- **Per-repo folders under `catalog/generated/`.** It changes C1's `<kind>/<id>.yaml` layout, and joins still cross repos.

## Plan for beta.27

The tickets follow the ticket loop: fixtures and failing tests first. They land in three phases: CS1 and CS4's harness, then CS2, then CS3 and CS5 side by side. beta.27 is cut when all five are done.

**CS1. The slot formats, the slot writers and the upgrade.**

- The zod schemas for the readers slot, the facts slot with its meta, and the dismissals file (`packages/scanner/src/slots.ts`, JSON Schema generated beside the others), with a canonical serializer.
- The scan writes readers slots, and `verify --write` writes the facts snapshot, while still writing the catalog as today. This phase changes no behaviour.
- The upgrade step, and the Forge golden slots, with the script that generates them.

Done when:

- Every format has golden files, and reading and writing it again is byte-identical.
- For each failure (not cloned, outside `--repos`, a reader throws, a timeout, a refused plugin, a cancel), a test shows the slot is byte-identical after the run.
- A refused `verify --write` leaves the snapshot byte-identical.
- The upgrade adopts a beta.26 Forge metarepo into labelled legacy slots, reports what it did not adopt, and does nothing on a second run.
- Regenerating the golden slots changes nothing.
- The guide and the changelog are updated, and `pnpm check` passes on Linux and Windows.

**CS4. The property tests.** These land with CS1, before CS2's code.

- The model, the commands and the nine invariants of point 9.
- The harness runs against today's writers, and records a shrunk counterexample for each invariant they break. These are kept as known failures that CS2 must turn green.

Done when:

- fast-check is added under the licence check.
- Every invariant has a property and a hand-written example.
- Seeds are printed and replayed.
- 100 sequences run in `pnpm check` in under 60 seconds, and the nightly job runs 2,000.
- No test touches the network.

**CS2. The build, and the six writers made to call it.**

- `buildCatalog` and `writeBuiltCatalog`, the projection cache, and the guards.
- `atticus catalog build [--check] [--json]`.
- The scan, `verify --write`, the glossary scan, the branch scan, the learning sandbox, rename and upgrade all go through the build.
- The carry code is deleted: `catalogWithFacts`'s `existing` patch and second `applyCurated`, the branch scan's `others`, `factsForScan`'s merge, and the scan's `kept`.

Done when:

- Every CS4 invariant passes.
- The golden test passes: the Forge golden slots build to `expected/scan.yaml`.
- ADR 0124's determinism tests pass through the build: three repos in any order, and a write repeated changing nothing.
- `packages/scanner/test/facts-estate.test.ts`'s golden is unchanged, or each difference is explained in the PR.
- A check fails when `writeCatalog` is imported anywhere but `build.ts`.
- The budgets of point 8 are met on the synthetic estate and pinned in a perf test.
- The `merge-input.ts` comment is tested.
- The docs, the codebase map and the changelog are updated, and `pnpm check` passes on Linux and Windows.

**CS3. The readers' cross-check in the app.**

- The comparison of point 3 in the build's report.
- The additive C4 routes: one to read a repo's cross-check, one to promote an item, one to dismiss it.
- The view in Map › Trust, with promote to assert (edit then propose, ADR 0190) and dismiss.

Done when:

- The routes have tests, and the API doc is regenerated.
- The view has its empty, loading, error and no-readers-slot states, and passes the WCAG 2.1 AA checks.
- Its words come from the copy file.
- A test shows a promoted item becoming a person's fact that the next `verify --write` verifies on its line and projects.
- A dismissed item stays dismissed until the readers' value changes.
- The view works in VS Code's panel and in IntelliJ.

**CS5. The fixtures and the journeys.**

- The test helper that seeds slots and builds (`packages/fixtures`).
- Moving every test that runs a writer from seeding `catalog/generated/` to seeding slots.
- New journeys:
  - a repo not cloned keeps its records through a scan;
  - `verify --write`, then a scan, keeps the facts' records, and the cross-check lists the readers' difference;
  - a curated suppress survives a scan and a `verify --write`;
  - `atticus upgrade` of a beta.26 metarepo, then a scan.

Done when:

- No test that runs a writer seeds `catalog/generated/` directly. A check lists any that do.
- The four journeys pass in the app's default layout.
- The 88 files' tests pass on Linux and Windows CI.
- `docs/build-status.md` is ticked.
