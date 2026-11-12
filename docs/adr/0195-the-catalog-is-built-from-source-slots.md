# 0195. The catalog is built from source slots: a scan or a verify writes only its repo's observation, and one pure build makes catalog/generated

- Status: accepted (2026-11-11). Settled in the beta.27 planning session, revised the same day after the product owner's review so that nothing in it can destroy data, and accepted with the three answers under "Decisions for the product owner".
- Date: 2026-11-11
- Release: 2.0.0-beta.27
- Amends: ADR 0003 (`catalog/generated/` is written only by the build, not "only by scans"), ADR 0124 addendum A3b ("What --write does": `--write` no longer patches the catalog it finds; its "Not done here" question, which source wins for a repo that has facts, is answered in point 2) and addendum A-incremental (the scan's own `factsForScan` carry is deleted, and the scan no longer writes facts at all: only `verify <repo> --write` does, point 1)
- Builds on: ADR 0010 (the scan runner and its cache), 0017 (merge identity), 0026 (curated decisions), 0031 (features from code), 0038 (federation), 0039 (the glossary), 0051 (upgrade and migrate), 0074 (results stored per commit), 0123 (branches), 0124 (facts, the verifier, the estate join), 0135 (why a link is there), 0151 (contract files and traffic), 0160 (another team's map), 0163 (terms), 0181 (the AI's targets), 0187 (the Console), 0190 (edit then propose)
- Contracts: no schema change to C1, C2, C3, C5, C6 or the facts file (`FACTS_SCHEMA_VERSION` stays 5). C4 gains additive routes for the cross-check view and for the confirm steps and undo (ticket CS3; a minor version, numbered when it lands, and an open decision below). New formats, not contracts, versioned here: the readers slot (`slotVersion: 1`), the facts slot (`slotVersion: 1`), the legacy joins slot (`slotVersion: 1`), the build manifest `catalog/sources/build.json` (`version: 1`) and the cross-check's dismissals (`version: 1`). `atticus scan --json` loses `kept`.

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
- **Terraform.** Data sources are read-only inputs. `-target` is known to cause drift because it plans with part of the state. `plan` shows every change before `apply` makes it.
- **Salsa, Bazel, stack graphs.** Derived results are recomputed from stored per-input results. Nobody patches derived output.
- **dbt.** Staging models per source, deterministic models built on them, and `hard_deletes` that are explicit.
- **Event-sourced read models.** A read model is rebuilt from the log, never edited.
- **Sourcegraph.** Precise code intelligence is uploaded per repo and per commit. Cross-repo links are resolved at query time, with a fallback to an older upload.
- **Feldera and fast-check.** Differential testing (incremental against from scratch) and model-based testing (`fc.commands`).

They agree: keep each source's last good observation, and recompute everything derived from all of them.

## Decision

### The principle: nothing destructive

**Nothing is removed or overwritten without being shown first; every write can be undone.**

The product owner set this after reading the first draft. Every point below follows it:

- **A command's own result is written and reported.** A scan's new read of a repo, a successful `verify --write`, a curated decision, and the records that follow from them are what the person asked for. They are written, listed in the command's output, and `atticus catalog undo` (point 7) takes any of them back.
- **Anything else is shown and waits.** A removal no input explains is refused. A large removal, a hand edit to `catalog/generated/`, the upgrade and the deletion of a slot file are listed and wait for confirmation (points 4 and 6). The CLI confirms with a flag that names the count it was shown (`--allow-removals 37`), so a confirmation never covers more than was listed. The app confirms in a step that lists them.
- **A refused command writes nothing**: no slot, no record file, no `build.json`.
- **Git is the long-term undo.** Everything Atticus writes here is a file under `catalog/`, committed in the catalog PR, so any earlier catalog and its slots can be checked out and built again.

### 1. Source slots, committed in the metarepo

Each repo has up to two **slots**: what was last observed of it, by the readers and by the assistant's verified facts. They are committed in the metarepo beside the catalog, and reviewed in the same catalog PR. One more slot holds what the upgrade adopted that no single repo owns.

| Slot         | Path                                                                              | Written by                                                                                                  |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Readers      | `catalog/sources/readers/<repo>.json`                                             | A scan that read the repo in full, at a known commit                                                        |
| Facts        | `catalog/sources/facts/<repo>.jsonl` and `catalog/sources/facts/<repo>.meta.json` | Only an explicit `atticus verify <repo> --write` that succeeds (nothing rejected). Never the scan.          |
| Legacy joins | `catalog/sources/legacy/joins.json`                                               | `atticus upgrade`, once (point 6). The build only retires entries from it, each reported, never adds to it. |

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

Anything less writes nothing for that repo. The slot keeps its last good content, with the commit it was read at, so staleness shows (point 5), and the scan says which repo kept its last read and why. The scan still writes the slots of the repos it did read in full. This narrows beta.26's all-or-nothing stop to the case it was right about, a scan that read nothing, which stays as a guard (point 4).

**The scan never writes a facts slot.** Only an explicit, successful `atticus verify <repo> --write` does. The scan does not run verify's write step or its own `factsForScan` merge. For a repo with a facts snapshot, the scan compares the files the facts cite at the snapshot's commit with the clone's HEAD. When one changed, the scan reports the repo's facts as stale, with the facts that cite the changed files, and suggests `atticus verify <repo> --write`. The snapshot stays as it is until that command succeeds. There is one facts writer, and a person runs it.

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
2. **The merge** of every repo's records with the intake records of `inputs/`, the federated catalogs (`mergeEstate`, `mergeCatalog`) and the legacy joins slot (point 6), as a full scan does today.
3. **The joins**, recomputed over every facts slot at once: `joinFacts` and `applyFactJoins` with the answers, the pairs and the AI's targets; the term grants (`joinTerms`); the shared maps (`joinSharedMaps`); and the link evidence of the contract files and traffic (`linkEvidenceOf`). The estate join is computed once for the estate, not once per written repo, so there is nothing to take off before putting back.
4. **The curated decisions**, applied once as the last overlay (`applyCurated`), keyed by the stable record ids they target. A decision whose target is not in the build is reported as orphaned and kept in `catalog/curated/`, so it applies again when its target returns. Link evidence moves before curation (`catalogWithFacts` applied it after), so a person's suppress always wins.
5. **The passes that read the curated catalog**: features (ADR 0031), then the glossary's terms (ADR 0039).
6. **The guards, then the write** (point 4).

No derived output is ever carried. Nothing the build wrote is ever read back as an input to what the next build makes: `build.json` is read only by the guards, and `catalog/sources/legacy/generated-before-upgrade/` is never read.

**Compute, guard, then write.** A command computes its new slots and the build in memory, runs the guards (point 4), and only then writes: the undo copy first (point 7), then the slots, then the record files (each atomically), then `build.json` last. A refusal writes none of them.

**The build manifest.** `catalog/sources/build.json` (`version: 1`, canonical JSON, no time) lists every file the last build wrote under `catalog/generated/`: its path, its SHA-256, and the sources it came from (slot paths and build inputs, each with the hash it had). The guards use it to find hand edits and to explain removals (point 4).

Every writer becomes "update my slot, then build":

| Writer               | Becomes                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atticus scan`       | Writes the readers slot of each repo read in full, then builds. It never writes a facts slot; it reports stale facts and suggests the verify command (point 1).                                                                                                                                                                         |
| `verify --write`     | Writes the facts snapshot when the run succeeds, then builds. The incremental patch on `existing` and the second `applyCurated` are deleted.                                                                                                                                                                                            |
| Glossary scan        | Writes the glossary's own inputs, then builds. It never patches record files.                                                                                                                                                                                                                                                           |
| Branch scan          | Writes `catalog/branches/<branch>/sources/readers/<repo>.json` for the branch's repos, then builds the branch's catalog from the baseline's slots with the branch's slots in place of its repos'. The `others` carry is deleted.                                                                                                        |
| The learning sandbox | Writes the sandbox's slots, then builds.                                                                                                                                                                                                                                                                                                |
| Repo rename          | Writes the repo's slot files under the new id first (the repo id rewritten inside them, and the curated targets, as now), checks that they parse and that the build from them passes its guards, and only then removes the old slot files, in the same commit. Any failure removes only the new files it wrote and leaves the old ones. |
| Upgrade              | Migrates slots step by step (ADR 0051), then builds. The first upgrade to slots is point 6.                                                                                                                                                                                                                                             |

Neither rename nor upgrade edits `catalog/generated/`; the build does.

`atticus catalog build` builds on demand, after a curated file is edited by hand or a merge conflict. `--check` writes nothing and exits non-zero when `catalog/generated/` is not what the slots build, which a metarepo's CI can run. The command, the app and the editors take the scan's lock. A crash part way through a write leaves the catalog behind but whole (each record file is written atomically), the undo copy already taken, and the next build catches it up: a file that matches either the last `build.json` or the interrupted build's manifest (kept in its undo copy) is a build's output, not a hand edit. A conflict in `catalog/generated/` or `build.json` after a git merge is always resolved by building again, never by hand: during a merge the hand-edit guard accepts a file that matches either side's `build.json` (read from git), and both sides of a conflicted file stay in git. A conflict in a slot is resolved by keeping either side (normally the later commit) and building.

`merge-input.ts`'s comment becomes true, and its tests prove it (point 10).

### 3. Readers where facts exist: a cross-check, never a silent merge

For a repo with a current facts slot and a readers slot with `status: read`, the build compares the readers slot with the facts projection and reports three lists. A legacy readers slot is not compared: it holds the old merged catalog, so the view says "no readers slot yet" until a scan. Records are matched by their C1 id, and by the kind's key where ids can differ: an Interface's caller, method and normalised path; a Table's name; a Column's `table.column`; a Setting's key. Nothing is matched fuzzily.

- **Readers found, the facts don't have it**: with the reader's evidence (file and line at the readers slot's commit).
- **They disagree**: the same record with a different value (a method, a path, an operation, a type), both values shown.
- **The facts have it, the readers don't**: a count, for information. The readers are known to miss things.

Map › Trust shows this per repo as the readers' cross-check. A "readers found" item has two actions:

- **Promote to assert.** The person checks the cited line, and Atticus writes a `by: person` fact with the reader's citation into `facts/<repo>.jsonl` as an edit to propose (ADR 0190). It reaches the catalog through the next successful `verify --write`, so the verifier checks the claim on its line like any other fact.
- **Dismiss.** The dismissal is kept in `facts/<repo>.crosscheck.yaml` (`version: 1`, the item's key and the readers' value). A dismissed item is listed again only when the readers' value changes.

Nothing in the cross-check changes the catalog by itself, and nothing the readers found is lost: the readers slot is kept whole.

### 4. Guards

The guards run on the build in memory, before any file is written. A refused build writes nothing (point 2), says why, lists what it would have done, and exits non-zero; `--json` gives `refused` with the reason and the list. The Console (ADR 0187) shows the same list.

- **A scan that read nothing writes nothing.** beta.26's safety stop stays, as a guard: when a scan read no repo in full, it writes no slot and runs no build, and says which repos it could not read and why.
- **No empty catalog over a full one.** The build refuses to write a catalog with no records over one that has records, unless the manifests list no repo.
- **Nothing removed unexplained.** A record the last build wrote that this build would not is a removal. It is explained when `build.json` traces it to one of:
  - a slot this command changed (the repo's new read or facts no longer produce it, or a join involving that repo no longer forms);
  - a repo the manifests no longer list;
  - a repo marked archived;
  - a curated decision (a suppress, or an alias that folds it into another record);
  - a build input other than a slot that changed: an answer, a pair, an AI target, a contract file, traffic, a shared map, `inputs/` or a federated catalog (an open decision below).

  A build with any removal that is not explained refuses and lists each record with the sources it came from. There is no flag to force it: an unexplained removal is a bug, and the list is its report.

- **Large removals are confirmed.** Explained removals of more than 10% of a repo's records, or more than 200 records in one build, refuse unless confirmed: `--allow-removals <count>` on any command that builds, with the count the refusal listed (any other count refuses again), or the app's confirm step, which lists them. Smaller explained removals are written and reported, by the repo of their evidence, in the command's output, the Console and the catalog PR's description. The limits are built in, not org-pack settings, because a setting would be a C6 change. Removing a repo from the manifests or archiving it removes all of its records, so that is always above the limit and always shown first.
- **Hand edits are never overwritten.** Before writing, the build hashes `catalog/generated/` and compares it with `build.json`. A file changed, added or deleted by hand makes the build refuse and list the files, with two ways on:
  - **Make it curated**, the supported way. `atticus catalog edits --curate` drafts, for each file, a curated assert of the changed fields (or of the added record), or a suppress for a deleted one, into `catalog/curated/` as edits to propose (ADR 0190). The build after them keeps the edit's effect, and so does every later build.
  - **Discard**, with explicit confirmation: `--discard-edits <count>` with the count listed, or the app's confirm step listing the files. The edited files are copied into the undo folder (point 7) before the build replaces them.
- **Slot files are never deleted automatically.** Slots of repos the manifests no longer list are orphaned: not built from, reported, and kept on disk. An archived repo's slots are kept and left out. Their records leave the catalog only through the removal guard above, as explained removals shown first. `atticus catalog prune` lists orphaned slot files, the slots of archived repos and `catalog/sources/legacy/generated-before-upgrade/`, and removes them only on confirmation (`--yes`, or the app's confirm listing them). Undo and git keep what it removed.

### 5. Staleness shows

A slot's commit is compared with the base clone's HEAD wherever the clone is there: the scan, `verify`, `atticus next`, Set up › Repos and Map › Trust. The build itself compares nothing; it reports each repo's source and commit (`facts at <commit>`, `readers at <commit>`, `legacy`, `none`). A repo whose slot is behind is shown as read at that commit, never as current and never as gone. A repo whose facts cite a file changed since the snapshot is shown with its stale facts and the verify command that refreshes them (point 1).

### 6. Upgrading a metarepo: every record adopted, shown first

An `atticus upgrade` step runs once, when `catalog/sources/` does not exist and `catalog/generated/` has records. It adopts **every** record of the current catalog, so nothing is lost:

- Records whose evidence names one repo go into that repo's readers slot with `status: legacy`, and with the commit the last scan recorded for the repo, else `unknown`.
- Records with evidence from several repos (joined Interfaces) and records with no evidence go into `catalog/sources/legacy/joins.json` (`slotVersion: 1`, `kind: legacy-joins`, `status: legacy`, the records sorted by kind and then id, and `inputs`: the hash of each slot and build input as it was at the upgrade).
- The step writes no facts slot: only `verify --write` does (point 1). For a repo whose `<repo>.verify.yaml` records a passing verify of the facts file as it is now (its hash matches), the report suggests `atticus verify <repo> --write`. Until then the repo's assistant records stay in its legacy slot.
- `catalog/generated/` is copied as it is to `catalog/sources/legacy/generated-before-upgrade/`, committed with the upgrade, so the catalog before the upgrade is in git history whatever happens later. The build never reads it; `prune` may remove it on confirmation.

**A legacy join stays until it is derived again.** The build uses a legacy join's record as it is while no current input derives a record with its id. Once a slot or input that the derived record comes from has changed since the upgrade (against the slot's `inputs`), the derived record takes the id, and the build retires the legacy copy from `joins.json` and reports it, with any fields that differed. A cross-repo arrow from before the upgrade is therefore never dropped because the build cannot derive it yet. A legacy join leaves the catalog without being derived only through the removal guard (point 4): one of its repos removed or archived, or a curated suppress. Map › Trust labels legacy joins "kept from before the upgrade, not yet derived from current inputs".

**Dry run first.** Without confirmation the step writes nothing. It shows the slots it would write and how many records each adopts, the repos whose facts could be verified, and what the first build would change, which must be nothing. It writes only on confirmation: `atticus upgrade --yes` on the CLI, or a confirm step in the app that lists the same. The first build after the upgrade gives a record set byte-identical to the catalog before. The build's passes are meant to leave their own output unchanged, but the step does not rely on that: if its dry-run build would differ in one byte, the upgrade refuses, writes nothing and lists the records that differ.

A legacy slot is labelled as such in Map › Trust and Set up › Repos, with "scan or verify this repo to replace it". When a scan or a verify replaces it, the records the new read no longer produces are explained removals (point 4), shown first when they are many. The step is idempotent: once `catalog/sources/` exists it does nothing.

The fixtures ship golden slots in `fixtures/forge/slots/`, generated by a script from `fixtures/forge/repos/`. They are golden files of the readers' output, reviewed as such. `fixtures/forge/expected/scan.yaml` stays hand-written and stays the oracle: a golden test asserts that building the golden slots with the Forge org pack gives that catalog.

### 7. Undo

Every command that builds and writes keeps an undo copy in `.index/build-undo/<n>/`, for the last five builds (local and git-ignored):

- the previous `build.json`, which is the hash list of the record set it replaced;
- the previous bytes of every record file it removed or changed, hand-edited files it discarded included;
- the previous bytes of every slot file the command wrote, moved or removed (readers, facts snapshot, legacy joins), `prune`'s removals included;
- the command that wrote it, the metarepo's commit and the time.

A build that changes nothing writes no undo copy.

`atticus catalog undo` lists the last five and takes back the latest. It shows what it will restore and, on confirmation (`--yes`, or the app's confirm step), puts back the previous record files, `build.json` and the slots that command touched, then checks every restored file against the restored `build.json`. `atticus catalog undo <n>` goes back to before build `n`, taking back the later builds in order. An undo keeps what it replaced in the same way, so an undo can itself be undone. Undo refuses over hand edits, as a build does.

What undo covers: everything a build or one of its writers wrote under `catalog/generated/` and `catalog/sources/` (a scan, `verify --write`, a rename, the upgrade, `prune`, a discard of hand edits).

What undo does not cover:

- files a person or the assistant edits: the live facts files, the dismissals, `catalog/curated/`, the answers and the other inputs. Git keeps their history;
- anything in a shared system, such as a PR opened or a ticket written. A person approves each of those (CLAUDE.md rule 6), and they are undone where they live;
- builds older than the last five, or made on another machine, because the undo folder is local. Git history is the long-term undo: every slot and catalog is committed, and any earlier one can be checked out and built;
- git itself: undo restores the working tree. After a commit, the undo is a new change to commit, never a rewrite of history.

### 8. Determinism, and the per-commit rule

The same slots, org pack, answers and other inputs give the same bytes, on Linux and Windows. Slots are the stored per-commit results of CLAUDE.md rule 4: the same commit with the same org pack and answers returns the same stored catalog, because the slot of that commit is the stored result and the build is a function of it. A changed file still invalidates only the facts that cite it, through verify's carry. Building again with nothing changed writes no file.

### 9. Performance

- Each slot's projection (the facts projected, or the readers' records read and checked) is cached by the hash of its bytes and the build's version in `.index/build-cache/`. The cache is local, git-ignored and never needed for a correct result: a build without it gives the same bytes, and the property tests check that (the differential test of point 10).
- The merge, the joins, the overlay and the guards (the hash check of `catalog/generated/` included) run every build. The budgets below are for an estate of 40 repos, with up to about 2,500 records and 12,000 facts in a repo. They are measured on a synthetic estate (`packages/synth`) in CI and move only with numbers:
  - one slot changed, the others cached: under 15 seconds;
  - a cold build: under 90 seconds;
  - the heap: under 1.5 GB;
  - an unchanged build: no file touched.

### 10. Testing

Model-based property tests with fast-check (`fc.commands`, a dev dependency under the licence check) run against a temporary metarepo whose readers are the mock reader adapter (CLAUDE.md rule 5).

- **The model** is small: for each repo, its readers slot, its facts slot and its live facts file, plus the curated decisions, the answers, the last build's catalog and the undo copies.
- **The commands**: scan (read in full; not cloned; a reader fails; cut short; outside `--repos`; nothing read), `verify --write` (succeeds, refused), a live facts edit without `--write`, a curated decision (alias, assert, suppress) added or removed, an answer given, a repo renamed (succeeds, the new slots fail to build), removed or archived, a hand edit to `catalog/generated/`, a refused build confirmed or not, `atticus upgrade` (dry run, `--yes`), `atticus catalog undo`, `atticus catalog prune` (confirmed or not), and a crash part way through a write.

| Invariant                       | Holds after any sequence of commands                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Equivalence (the master oracle) | The catalog is byte-identical to a full build of a fresh metarepo given only the final slots and inputs, with and without the build cache.                                                                                      |
| Locality                        | A change to one repo's slot changes only records with that repo's evidence, or derived from a join that involves it.                                                                                                            |
| Idempotence                     | Building twice, or scanning an unchanged repo, changes no byte.                                                                                                                                                                 |
| Order independence              | Scans and writes of different repos in any order give the same bytes.                                                                                                                                                           |
| Failure neutrality              | A failed, partial, cut-short, out-of-set or refused run, or a scan that read nothing, leaves every slot and the whole catalog byte-identical.                                                                                   |
| Readers never destroy facts     | For a repo with a current facts slot, no change to its readers slot changes a field of a record projected from its facts, and no scan changes a byte of any facts slot.                                                         |
| Curation survives               | A curated decision's effect is in the catalog whenever its target is. When the target is gone, the decision is reported orphaned and kept, not dropped.                                                                         |
| Links are live                  | Every cross-repo Interface follows from the current slots and inputs. No derived arrow outlives its caller or its callee; a legacy join leaves only when it is derived again or through the removal guard.                      |
| Nothing removed unexplained     | Every record removed between two builds is in the build's report and explained by a changed slot or input, a removed manifest entry, an archived repo or a curated decision. A build with any other removal writes no byte.     |
| Upgrade is lossless             | After `atticus upgrade --yes`, every record of the catalog before is in exactly one legacy slot and in `generated-before-upgrade/`, and the first build's record set is byte-identical to it. A dry run writes no byte.         |
| Undo restores                   | After any command that wrote, `atticus catalog undo` gives `catalog/generated/`, `build.json` and the slots that command touched byte-identical to before it; undoing that undo gives them back as they were after the command. |
| Hand edits never silently lost  | A build over a hand-edited `catalog/generated/` writes no byte until each edit is made curated or its discard is confirmed with its count, and a discarded edit's bytes are in the undo copy.                                   |

Large explained removals are also tested: without the right `--allow-removals <count>` the build writes no byte. Each invariant also has a hand-written example test. Failing seeds are printed and replayed. `pnpm check` runs 100 sequences, and a nightly job runs 2,000. The golden tests (the Forge slots to `expected/scan.yaml`; ADR 0124's three repos in any order) and the journeys (ticket CS5) sit on top.

## Consequences

- A scan can no longer delete what it did not read. A repo that is not cloned, outside `--repos`, or whose reader failed keeps its last good read, and says so. A scan with one failing repo still records the others, which beta.26's stop did not allow. A scan that read nothing still writes nothing.
- `verify --write` and a scan can no longer undo each other. For a repo with facts, the facts are the source and the readers are the cross-check, which ADR 0124 §3 promised and the merge never kept. Only a person's `verify --write` changes a facts slot.
- Curated decisions are applied once, last, and can no longer be undone by carried records. Stale derived arrows cannot come back, because nothing derived is carried. Arrows from before the upgrade are kept as legacy joins until they are derived again.
- Some commands now stop and ask. A removal no input explains, a large removal, a hand edit to `catalog/generated/`, the upgrade and `prune` are listed and wait. A scripted or CI run that meets a guard exits non-zero and writes nothing; the confirmation flags name a count, so a script cannot confirm what it was not shown.
- The metarepo gets `catalog/sources/`, about as large again as `catalog/generated/`, plus `legacy/generated-before-upgrade/` until it is pruned. A catalog PR shows each slot that changed, then the derived records that changed with it. Slots are per repo, so two people scanning different repos do not conflict.
- `catalog/generated/` stays C1, committed, and is what every consumer reads: the index, the critic, the planner, the API, the app, the editors and the bench. None of them changes. It becomes purely derived, but a hand edit to it is no longer overwritten: the build finds it and offers to make it a curated decision.
- The `kept` field of `atticus scan --json`, which summarised the carried records, goes away. Nothing is carried. `--json` gains `sources` (per repo: `{ repo, source: facts|readers|legacy|none, commit, slot: written|unchanged|kept-last-good|none, reason?, factsStale? }`), `removed`, `retired` (legacy joins derived again) and `refused`.
- `.index/scan-cache/` (ADR 0010) stays as it is: a local speed-up for the readers, below the slots. `.index/build-undo/` holds up to five builds' changed files.
- The 88 test files that seed `catalog/generated/` from `expected/scan.yaml` split in two. Tests that only read the catalog may keep seeding it, because it is still C1. Tests that run a writer seed slots instead (ticket CS5), with a `build.json` to match.
- Writing a slot and building are one locked operation. The lock is held longer than a scan's write was, by the build's time and the guards' (point 9).

## Alternatives considered

- **Carry derived output into the next merge** (the two beta.26 attempts). Rejected for the failures listed in the context: each one patches output that a later pass has already transformed. That is the bug Salsa, Bazel and event sourcing avoid by never patching derived results.
- **Keep beta.26's stop as the design.** Safe, but a scan with one repo missing does nothing. It also leaves the six writers with six pass sets, so the catalog still depends on which wrote last. Its one sound case, a scan that read nothing, stays as a guard.
- **Per repo, the newest source wins** (readers newer than the facts replace them). Rejected: a routine scan would flip a repo from facts to readers and back, which is the beta.25 loss in another form.
- **Merge readers and facts record by record, with fuzzy de-duplication.** Tried, and it dropped real findings. The cross-check (point 3) shows the same differences to a person, with nothing dropped.
- **Field ownership in each record, as Kubernetes' `managedFields` does.** It would change C1 (rule 1) for every consumer, and it is still a patch on derived output.
- **Make `.index/scan-cache/` the source.** It is local and git-ignored, so the next person's machine has none of it, and their scan would delete again. Slots are the same idea, committed.
- **An event log of every scan and write, with the catalog rebuilt from it.** Correct, but the log grows without end, and the catalog needs only the latest observation of each source. Slots are that log compacted to its last entry per source, with git and the undo copies keeping what came before.
- **Resolve cross-repo links at query time, as Sourcegraph does.** Every C1 consumer would have to join at read time. Building once and writing C1 keeps the consumers as they are.
- **Per-repo folders under `catalog/generated/`.** It changes C1's `<kind>/<id>.yaml` layout, and joins still cross repos.
- **Report large removals and write them anyway** (the first draft). Rejected by the product owner's direction: a removal is shown before it is written.
- **Let the scan refresh the facts snapshot** (the first draft ran verify's write step inside the scan). Rejected: a scan is not a verify, and facts reach the catalog only when a person runs `verify --write` and it succeeds.
- **Upgrade without adopting joined records, and let the build derive them again** (the first draft). Rejected: it could drop a cross-repo arrow the build cannot derive yet.

## Decisions for the product owner

Resolved by the owner's direction, "nothing destructive" (2026-11-11):

- **The upgrade adopts every record** into legacy slots, single-repo records by repo and the rest into `legacy/joins.json`, copies the old catalog into `generated-before-upgrade/`, runs as a dry run and writes only on confirmation. Its first build is byte-identical to the catalog before (point 6).
- **Removals refuse.** An unexplained removal refuses with no override, and explained removals above 10% of a repo or 200 in a build wait for a confirmation that names the count (point 4).
- **Hand edits are kept.** The build finds them against `build.json`, refuses, and offers to make each a curated decision or to discard it with confirmation (point 4).
- **Only `verify <repo> --write` writes facts.** The scan reports stale facts and suggests the command (point 1).
- **Rename writes the new slots before removing the old ones**, and a failure leaves the old ones (point 2).
- **Orphaned and archived repos' records leave only through the removal guard**, and slot files are removed only by a confirmed `atticus catalog prune` (point 4).
- **Undo** over the last five builds, with git history as the long-term undo (point 7).
- **beta.26's stop stays as a guard**: a scan that read nothing writes nothing (point 4).

Decided by the owner (2026-11-11), with the recommended option each time:

- **The additive C4 routes: yes.** CS3 adds routes to the local API for the cross-check (read, promote, dismiss) and for the confirm steps (read a refused build's or the upgrade's list, confirm it with its count, prune, undo). They are additive: a minor `API_VERSION`, the API and spec docs regenerated, and an ADR note when they land.
- **Facts behind HEAD still win: kept.** For a repo with a current facts slot, the facts are the source even when the readers slot was read at a later commit (point 2). Nothing is lost: the readers slot is kept whole, what the readers found that the facts lack and every value they disagree on is shown in the cross-check (point 3) with promote to assert, and the scan says when the facts are stale.
- **A changed non-slot input explains a removal: yes, and it is listed.** When an answer, a pair, an AI target, a contract file, traffic, a shared map, `inputs/` or a federated catalog changed and the record came from it, the removal is explained (it is the person's own action): written and listed in the build report when small, confirmed when large, and undoable (point 7).

## Plan for beta.27

The tickets follow the ticket loop: fixtures and failing tests first. They land in three phases: CS1's formats and slot writers with CS4's harness; then CS2, with CS1's upgrade step, because the upgrade's dry run builds; then CS3 and CS5 side by side. beta.27 is cut when all five are done.

**CS1. The slot formats, the slot writers and the upgrade.**

- The zod schemas for the readers slot, the facts slot with its meta, the legacy joins slot, `build.json` and the dismissals file (`packages/scanner/src/slots.ts`, JSON Schema generated beside the others), with a canonical serializer.
- The scan writes readers slots, and `verify --write` writes the facts snapshot, while still writing the catalog as today. This phase changes no behaviour. The scan never writes a facts slot, and reports stale facts.
- The upgrade step (landing with CS2), and the Forge golden slots, with the script that generates them.

Done when:

- Every format has golden files, and reading and writing it again is byte-identical.
- For each failure (not cloned, outside `--repos`, a reader throws, a timeout, a refused plugin, a cancel), a test shows the slot is byte-identical after the run. A scan that read nothing writes no file.
- A refused `verify --write` leaves the snapshot byte-identical. A scan over a repo whose cited files changed leaves the snapshot byte-identical and reports the verify command.
- On a beta.26 Forge metarepo, `atticus upgrade` without `--yes` writes no byte and lists the slots it would write and the first build's changes (none).
- With `--yes`, the upgrade adopts every record: single-repo records into labelled legacy readers slots, joined and evidence-less records into `legacy/joins.json`, and a byte-identical copy of the catalog into `generated-before-upgrade/`. No record is left out.
- The first build after the upgrade gives a record set byte-identical to the catalog before.
- An upgrade whose dry-run build would differ refuses, writes nothing and lists the records. A second run does nothing.
- A legacy join is kept while the build cannot derive it, and retired and reported once a changed input derives its id.
- Regenerating the golden slots changes nothing.
- The guide and the changelog are updated, and `pnpm check` passes on Linux and Windows.

**CS4. The property tests.** These land with CS1, before CS2's code.

- The model, the commands and the twelve invariants of point 10.
- The harness runs against today's writers, and records a shrunk counterexample for each invariant they break. These are kept as known failures that CS2 must turn green.

Done when:

- fast-check is added under the licence check.
- Every invariant has a property and a hand-written example.
- Seeds are printed and replayed.
- 100 sequences run in `pnpm check` in under 60 seconds, and the nightly job runs 2,000.
- No test touches the network.

**CS2. The build, and the six writers made to call it.**

- `buildCatalog` and `writeBuiltCatalog`, `build.json`, the projection cache, the guards and the undo copies.
- `atticus catalog build [--check] [--json] [--allow-removals <count>] [--discard-edits <count>]`, `atticus catalog edits --curate`, `atticus catalog undo [<n>]` and `atticus catalog prune`. `--allow-removals` is taken by every command that builds.
- The scan, `verify --write`, the glossary scan, the branch scan, the learning sandbox, rename and upgrade all go through the build.
- The carry code is deleted: `catalogWithFacts`'s `existing` patch and second `applyCurated`, the branch scan's `others`, `factsForScan`'s merge, and the scan's `kept`.

Done when:

- Every CS4 invariant passes.
- The golden test passes: the Forge golden slots build to `expected/scan.yaml`.
- ADR 0124's determinism tests pass through the build: three repos in any order, and a write repeated changing nothing.
- `packages/scanner/test/facts-estate.test.ts`'s golden is unchanged, or each difference is explained in the PR.
- A build with an unexplained removal writes no byte and lists it. Explained removals above the limits write no byte without the listed count, and a wrong count refuses. Smaller ones are written and reported.
- A hand-edited, added or deleted file under `catalog/generated/` makes the build refuse and list it. `edits --curate` turns it into a curated assert or suppress that the next build keeps. A confirmed discard copies the file into the undo copy first. A file that matches either side's `build.json` after a git merge, or an interrupted build's manifest, is not a hand edit.
- Rename writes the new slots first. A test where the new slots fail to parse or build leaves the old slots and the catalog byte-identical.
- Removing a repo from the manifests or archiving it removes its records only through the confirmed removal guard, and deletes no slot file. `prune` removes nothing without confirmation.
- `catalog undo` restores `catalog/generated/`, `build.json` and the touched slots byte-identical for each of the last five builds, and an undo can be undone.
- A check fails when `writeCatalog` is imported anywhere but `build.ts`.
- The budgets of point 9 are met on the synthetic estate and pinned in a perf test.
- The `merge-input.ts` comment is tested.
- The docs, the codebase map and the changelog are updated, and `pnpm check` passes on Linux and Windows.

**CS3. The readers' cross-check and the confirm steps in the app.**

- The comparison of point 3 in the build's report.
- The additive C4 routes: one to read a repo's cross-check, one to promote an item, one to dismiss it; and the confirm steps' routes: read a refused build's list or the upgrade's dry run, confirm it with its count, prune, and undo.
- The view in Map › Trust, with promote to assert (edit then propose, ADR 0190) and dismiss, and the legacy labels of point 6.
- The confirm steps: a refused build's removals or hand edits (with "make it curated" and discard), the upgrade's dry run, `prune` and undo, each listing what it will change before it changes it.

Done when:

- The routes have tests, and the API doc is regenerated.
- The view and each confirm step have their empty, loading, error and no-readers-slot states, and pass the WCAG 2.1 AA checks.
- Their words come from the copy file.
- A test shows a promoted item becoming a person's fact that the next `verify --write` verifies on its line and projects.
- A dismissed item stays dismissed until the readers' value changes.
- A test shows no confirm step writes anything until it is confirmed, and that it confirms exactly the list it showed.
- The view and the confirm steps work in VS Code's panel and in IntelliJ.

**CS5. The fixtures and the journeys.**

- The test helper that seeds slots, with a matching `build.json`, and builds (`packages/fixtures`).
- Moving every test that runs a writer from seeding `catalog/generated/` to seeding slots.
- New journeys:
  - a repo not cloned keeps its records through a scan;
  - `verify --write`, then a scan, keeps the facts' records, and the cross-check lists the readers' difference;
  - a curated suppress survives a scan and a `verify --write`;
  - `atticus upgrade` of a beta.26 metarepo, shown first and confirmed, then a scan, with every cross-repo arrow still there;
  - a hand edit to `catalog/generated/` made curated, then a scan that keeps it;
  - a removal above the limit refused, confirmed, then undone.

Done when:

- No test that runs a writer seeds `catalog/generated/` directly. A check lists any that do.
- The six journeys pass in the app's default layout.
- The 88 files' tests pass on Linux and Windows CI.
- `docs/build-status.md` is ticked.

## Addendum (CS1, as built, 2026-11-11)

The formats of point 1, as `packages/scanner/src/slots.ts` writes them (zod, with JSON Schema under `sources/` from `atticus schema export`). Every JSON file is two-space indented, LF, one trailing newline, its top-level keys in the order listed; nested free-form values (records, contracts, a dismissed value) are in the catalog's canonical key order. Reading any of them and writing it again gives the same bytes (golden files in `fixtures/forge/slots/`).

- **Readers slot**: `slotVersion`, `kind: readers`, `repo`, `commit`, `status` (`read` | `legacy`; a `read` slot never has commit `unknown`), `extractors` (`{ id, version }`, sorted by id), `settings` (SHA-256 of the canonical JSON of the repo's scan-settings entry, the dialects used on it and the framework models, each sorted by name, and the plugins that ran with `id`, `version`, `sha256` and `limits`), `records` (each a C1 record parsed as one, at `SCHEMA_VERSION`, a Flow at its own; sorted by kind then id). The records keep their evidence as the readers stamped it, `scannedAt` included: it is C1, and the scan cache keeps it for an unchanged repo, so an unchanged repo writes the same bytes; `--full` stamps afresh, as it does in `catalog/generated`.
- **Facts slot**: `<repo>.jsonl` is `serializeFacts` of the facts verify kept (by id, canonical; a newer Atticus's lines are not in it). `<repo>.meta.json`: `slotVersion`, `kind: facts`, `repo`, `commit` (the commit verify checked), `factsSchemaVersion`, `factsHash` (SHA-256 of `<repo>.jsonl`), `contracts` (the `ContractsFile` verify wrote to `facts/<repo>.contracts.yaml`, or `null`). The meta is written after the facts, so a write cut short between them leaves a hash that doesn't match.
- **Legacy joins slot**: `slotVersion`, `kind: legacy-joins`, `status: legacy`, `records` (as the readers slot's), `inputs` (an object from each slot's or build input's path to its SHA-256, keys sorted).
- **`build.json`**: `version: 1`, `files` (sorted by path), each `{ path, sha256, sources }` with `sources` a sorted list of `{ path, sha256 }`.
- **Dismissals** (`facts/<repo>.crosscheck.yaml`, canonical YAML): `version: 1`, `dismissed` (sorted by key), each `{ key, readers }`: the item's key (`<Kind>|<the kind's key>`, as point 3 matches) and the readers' value it was dismissed at.

What CS1 writes, and when:

- The scan writes readers slots in `atticus scan` only when it writes `catalog/generated`. beta.26's stop is unchanged, so a scan with any production repo not read in full writes no slot at all, and its message, "Nothing written", stays true; `scanEstate`'s `observations` already say, per repo, a full read or why not, and CS2 lifts the gate so the repos read in full are written. `writeReadersSlots` takes the gate as `hold`.
- Besides the failures of point 1, two more are no observation: a plugin that applies to the repo but isn't used (its pin changed or is missing, or its golden tests fail: the sandbox never ran it, so the read is short of it, though beta.26 still writes the catalog), and the readers switched off (`ATTICUS_HELPERS_OFF=readers`), where no reader ran.
- `verify --write` takes the snapshot inside `writeFactsIntoCatalog`, under the scan's lock, after the contract companion and before `writeCatalog`. A prototype gets none (it is never in the catalog).
- For each cloned repo with a snapshot, the scan compares the snapshot's commit with HEAD (`changesSince`, then `staleCite` on each fact) and reports the facts citing a changed file by file, a commit it can't compare, or a snapshot that doesn't read or whose hash doesn't match, each with `atticus verify <repo> --write`. `--json` carries it as `sources[].factsStale`.

CS1's review, fixed with CS2 (2026-11-11):

- No time is written into a slot: the evidence a reader stamps is stamped with the commit's committer date (`checkoutState` reads it), so the same commit read on any machine, cached or not, `--full` or not, writes the same bytes. (The addendum's "`--full` stamps afresh" no longer holds.)
- A clone with changes not committed is no observation (`dirty`); Atticus's own `.atticus/` folder doesn't make a clone dirty, so a repo adopted in place isn't dirty after its first scan.
- A readers slot's `repo` is a record id; `settings` is `null` and `extractors` empty for a `legacy` slot; `parseReadersSlot(text, repo)` checks the file's repo and that every record's evidence names the slot's repo; writers read back what they serialize before writing.
- `build.json` gains `buildVersion` (`BUILD_VERSION` in `slots.ts`): a change of it explains a removal. Every SHA-256 in `build.json` and the slots is over LF-normalised text, so a Windows checkout (`core.autocrlf`) never looks like a hand edit.
- A dismissal's `readers` is required. `fixtures/forge/slots/build.json` is now the golden manifest of building the golden readers slots (checked and regenerated by `packages/scanner/test/build.test.ts`, `UPDATE_GOLDEN=1`).
- `verify --write`'s preview lists the snapshot and `build.json` only on the successful non-prototype path, and only when they would change.

## Addendum (CS2, as built, 2026-11-11)

**Where it is.** `packages/scanner/src/build.ts`: `loadBuildInputs`, `buildCatalog`, `guardBuild`, `writeBuiltCatalog` (the only caller of `writeCatalog`; `packages/scanner/test/build.test.ts` fails on any other use in a package's `src/`), the undo copies (`takeUndoCopy`, `listUndo`, `planUndo`, `applyUndo`) and `buildAndWrite`, every writer's path ("update my slot, then build": the command's slot writes in place of what is on disk, the build, the guards, then the undo copy, the slots, the record files and `build.json` last). `build-facts.ts` projects every facts slot at once (no catalog read, nothing patched); `upgrade-slots.ts` is the upgrade's step; `scan-write.ts` the scan as a writer for callers other than the CLI (the learning sandbox). The CLI's own commands: `packages/cli/src/catalog-build-commands.ts`.

**The order of the passes, as built.** Point 2 lists the joins after the merge and the features and glossary after the curated decisions. The build keeps the order the scan has always had, which the Forge oracle (`expected/scan.yaml`) is written against: per repo one source; the framework models; the estate join over every facts slot at once (answers, pairings, the AI's targets, gateway callers, term grants) put into the code records before the merge, as the scan joined them; the merge (with `read` set to the repos read from facts, as `verify --write` merged) and intake's second merge; the remaps of the facts' endpoint and loose-call ids; features; federation; glossary; link evidence and shared maps; the legacy records; the curated decisions once, last. Link evidence is before curation, as point 2 says, so a suppress wins. Features and the glossary read curated decisions themselves (names, merges, glossary decisions) and the overlay applies them again idempotently, so their output is what it would be after.

**What `verify --write` builds now.** Every build runs every pass, so a `verify --write` writes the features and glossary terms it never wrote (the golden catalog `packages/verify/test/fixtures/map/forge-ledger.catalog.yaml` gains exactly those, nothing else in it changed), and its estate join reads facts slots only, never another repo's live facts file: a repo is read for the join once its `verify --write` took its snapshot. The first `verify --write` of a repo the readers read replaces their records with the facts', which is often a removal above the limit, confirmed with its count. `catalogWithFacts` stays for its own tests and no writer calls it; the scan no longer calls `factsForScan`.

**Legacy records.** A legacy slot's records are the old catalog after all its passes, so they are overlaid as they are, after link evidence and shared maps and before the curated decisions (applying a decision again is idempotent), rather than merged again (the merge, features and glossary are not idempotent on their own output). A legacy join leaves `joins.json` when the passes derive a record with its id and an input of `joins.json`'s `inputs` changed since the upgrade (reported under `retired`, with the fields that differed); it leaves the catalog without being derived when a repo its evidence names is no longer listed or is archived, or by a suppress. The upgrade's dry run therefore gives the old catalog byte for byte unless a pass derives, from inputs alone, a record the old catalog didn't have; then it refuses and lists the files.

**`build.json`'s sources.** Each file lists the slots of the repos its evidence names (the one used: the facts snapshot and its meta, or the readers slot; `legacy/joins.json` for a legacy join), one entry `catalog/sources` (a hash of every slot the build used: a join with any repo may rest on it) and each non-slot input by its path: the org pack, `catalog/curated`, the answers (the answered questions only: a question raised or refreshed while open changes nothing), `facts/*.corrections.jsonl` (the pairings, as one entry), `evidence/traffic`, `shared`, `inputs`, `catalog/proposals` and each federated catalog. Every input is listed even when empty, so the first answer or decision changes a hash a record recorded. A removal is explained when one of its recorded sources is not among the new build's with the same hash, when a repo its evidence names is no longer listed or is archived, when a suppress removed it, or when `buildVersion` changed. Each removal says why in words (`explainedBy`) and as kinds (`reasons`: `manifest`, `archived`, `curated`, `slot`, `input`, `build`, most specific first). The wiki folders the glossary reads are not hashed (a known gap: a glossary term a changed wiki page no longer gives is an unexplained removal, so it refuses and lists itself).

**The guards, as built.** Large removals are counted per repo of the record's evidence over the last build's records (more than 10% of the records it had) or more than 200 in all, and confirmed with `--allow-removals <count>` on `atticus scan`, `verify <repo> --write`, `repo rename` and `catalog build`; any other count refuses again. A hand edit is a file changed, added or deleted since `build.json`, unless it matches the manifest of a build that was cut short (kept as `next-build.json` in that build's undo copy) or holds exactly what this build writes; `--discard-edits <count>` replaces them, their bytes in the undo copy. `atticus catalog edits --curate` drafts, for each changed file, a curated assert of the fields it changed (identity and provenance fields can't be asserted, and are said) and, for each deleted file, a suppress; an added record can't be a curated decision (one changes or suppresses a record the build makes) and is said. It doesn't build: it notes the edits it made curated (`.index/build-curated-edits.json`, local), and the next build replaces those files, keeping their bytes in its undo copy. A metarepo whose `catalog/generated` has record files and no `build.json` (written before beta.27) refuses every writer until `atticus upgrade --yes` adopts it, or `--discard-edits` with the count of its files replaces it. A scan that read no repo in full refuses, with no slot and no build, even when there was no repo to read; a build with no record from any repo's code over a catalog with some refuses whenever the manifests list a repo, archived ones too, and no flag overrides it.

**Undo.** `.index/build-undo/<n>/` under the state folder: `undo.json` (the command, the metarepo's commit read from `.git`, the time, each file touched and whether it was there), `files/` (the bytes before) and `next-build.json`. `atticus catalog undo` lists the last five builds newest first, numbered 1 to 5, and with `--yes` puts back the latest; `undo <n> --yes` takes back the n latest in order. An undo keeps what it replaced as a copy of its own, so it can be undone. Undo refuses over hand edits and checks every restored file against the restored `build.json`. `atticus catalog prune` lists the slot files of repos no longer listed or archived and `legacy/generated-before-upgrade/`, and removes exactly those with `--yes`, with an undo copy.

**The upgrade.** `atticus upgrade` runs its other steps as before; the slots step shows what it would write and runs only with `--yes`, under the scan's lock, with an undo copy. `--check` and `--dry-run` count it. Once `catalog/sources/build.json` exists, the catalog-version steps no longer rewrite `catalog/generated` (the build's output).

**The other writers.** `atticus scan --ref <branch>` writes `catalog/branches/<branch>/sources/readers/<repo>.json` and builds the branch's catalog from the baseline's slots with the branch's in place of its repos', into `catalog/branches/<branch>/generated` with its own `build.json`; a branch folder an earlier version wrote is replaced on its first build (its bytes in the undo copy). `atticus glossary scan` writes its proposals and the build writes the terms; a glossary decision is followed by a build. The learning sandbox scans through `scanIntoCatalog`. The run log keeps `catalog build`, `edits`, `undo` and `prune` (ADR 0187); a refusal says what and why, and the command to go on, in the terminal, the Console and the app's job errors.

**Not done in CS2.** The hand-edit guard reading both sides' `build.json` during a git merge (point 2): a conflict is resolved by building again, which refuses over files neither the last nor an interrupted build wrote. The projection cache and the 40-repo budgets of point 9 and their perf test. The cross-check of point 3 and the app's confirm steps (CS3).

### Types for CS3

The app's confirm steps and views build against these exports of `@maycombhq/scanner` (`packages/scanner/src/build.ts`), stable from CS2:

- `BuildAndWrite` (`{ build, guard, write?, upToDate? }`), the result of `buildAndWrite(root, { command, slots?, allowRemovals?, discardEdits?, check? })`; with `check: true` it builds and guards and writes nothing, which is how a confirm step reads a refused build's list.
- `GuardResult` and `BuildRefusal`: `reasons: RefusalReason[]` (`nothing-read`, `empty`, `unexplained-removals`, `large-removals`, `hand-edits`, `not-upgraded`), `message`, `removals?: Removal[]` with `allowRemovals` (the count to confirm), `unexplained?`, `edits?: HandEdit[]` with `discardEdits` (the count to discard).
- `Removal` (`path`, `kind`, `id`, `repos`, `explainedBy`, `reasons: RemovalReason[]`) and `HandEdit` (`path`, `how`: `changed`, `added` or `deleted`).
- `WriteResult` (`written`, `unchanged`, `removed`, `slots`, `undo?`, `removals`, `discarded`).
- `Build.sources: RepoSource[]` (per repo: `source` of `facts`, `readers`, `legacy` or `none`, `commit`, `slot`, `problem?`), `Build.retired: RetiredJoin[]`, `Build.orphaned`, `Build.orphanedDecisions`.
- Undo: `listUndo(await undoDirOf(root))`, `planUndo(undoDir, n?)` (`UndoPlan`: `copies`, `files`), `applyUndo(root, undoDir, plan, command)`.
- `buildLines(root, r)`: a build's report in words, as the CLI and the Console say it. `refusalHint(refusal, command)` and `buildJson(r)` in `packages/cli/src/catalog-build-commands.ts` give the one-line hint with the command to run and the `--json` shape.

## Addendum (CS3, as built, 2026-11-11)

The readers' cross-check and the build's confirm steps in the app. C4 3.12.0 (additive, the owner's decision of 2026-11-11); the API and spec documents regenerated.

**The comparison** (`packages/scanner/src/crosscheck.ts`). For each production repo, `readCrossCheck` reads the slots on disk (files only) and says one of: `compared` (a current facts slot and a `read` readers slot), `no-facts` (the readers are its source, nothing to check), `no-readers` (no readers slot yet), `legacy` (point 6's slot, not compared until a scan) or `unusable` (a slot that doesn't read, with why). A compared repo's facts are projected alone (`factsEstateRecords` with the targets its answers name), the same records the build starts from, before the estate join and the curated overlay; the readers' records are the slot's, before the merge. Matching is by C1 id, then by the kind's key, never fuzzily:

| Kind      | Key (`<Kind>\|…`)                                        | Value compared (and kept by a dismissal) |
| --------- | -------------------------------------------------------- | ---------------------------------------- |
| Interface | caller, method, normalised path (`{…}` and `:x` as `{}`) | `from`, `to`, `method`, `path`, `via`    |
| Endpoint  | method, normalised path                                  | `method`, `path` (as written)            |
| Table     | name                                                     | `dataStore`, `name`, `tableKind`         |
| Column    | the table's last segment, `.`, the column                | `type`, `nullable`                       |
| Setting   | key                                                      | `valueOrRef`                             |
| any other | id                                                       | its scalar fields                        |

A disagreement is a field both values state with a different value. The readers may say one thing twice before the merge (a controller and the OpenAPI file beside it): that is one item citing every line. Items are sorted readers-only, disagree, facts-only, then by kind and key; the same records give the same items in any order. A dismissal (`dismissalsAfter`) is kept at the readers' value the item has now and holds while that value is the same. The golden is the Forge slots' cross-check, `fixtures/forge/expected/crosscheck.json` (17 found by the readers only, 2 disagree, 12 in the facts only, 5 agree for `forge-ledger`; every other repo `no-facts`).

**The command.** `atticus catalog crosscheck [<repo>] [--json] [--dismiss <key> | --undismiss <key> | --promote <key>]` (`cli/src/crosscheck-commands.ts`): the counts per repo, a repo's items in words, a person's dismissal into `facts/<repo>.crosscheck.yaml` and a person's promote to assert into `facts/<repo>.jsonl` (both refused in a Copilot session, `ai/src/person-only.ts`). A key that isn't a readers-found or disagreeing item now writes nothing. `catalog build|edits|undo|prune|crosscheck` keep a run log (core's `run-log.ts`), so a terminal's run is in the Console.

**The routes** (`cli/src/ui-api-catalog.ts`). `/api/catalog/{kind}` was taken (a kind's records), so the build's are under `/api/build`:

| Route                                     | Does                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/crosscheck`                     | `CrossCheckView`: each repo's state, commits, slot paths, counts and the base clone's commit (`head`), items left out                                                                                                                                                                                   |
| `GET /api/crosscheck/{repo}`              | `RepoCrossCheck` with its items (400 not an id, 404 not listed)                                                                                                                                                                                                                                         |
| `POST /api/crosscheck/{repo}/dismiss`     | `{ key, undo? }`: the command as a local job (202, its lines in the Console)                                                                                                                                                                                                                            |
| `GET /api/crosscheck/{repo}/promote?key=` | `CrossCheckPromoteView`: the `by: person` fact promoting the item writes (its JSON line and SHA-256), the line it cites at the readers' commit with the line's text when the checkout is at that commit, the facts file, `fromSnapshot`, `already`; or `can: false` with why                            |
| `POST /api/crosscheck/{repo}/promote`     | `{ key, sha256 }`: 409 unless the fact is still the one previewed; else `catalog crosscheck <repo> --promote <key>`, then `atticus verify <repo>`, as one local job                                                                                                                                     |
| `GET /api/build`                          | `CatalogBuildView`: `sources`, `pending` (built in memory and guarded as `catalog build --check`: up to date, removals, `refused` with its lists and counts and the command), `last` (the latest build's own report, `readBuildReport`), `upgrade` (the upgrade to slots waits), `orphaned`, `problems` |
| `GET /api/build/upgrade`                  | `CatalogUpgradeView`: `upgradeSlotsView` (what `atticus upgrade --json` lists under `slots`), `plan` (SHA-256 of the files listed, path and hash each) and `others` (the upgrade's other steps that wait)                                                                                               |
| `POST /api/build/upgrade`                 | `{ count, plan }`: 409 unless the step waits, would apply, no other step waits, and the files are that many with that plan now; else `atticus upgrade --yes` as a local job                                                                                                                             |
| `POST /api/build`                         | `{ allowRemovals?, discardEdits? }`: `atticus catalog build` with those counts, as a local job; any other count refuses again and writes nothing                                                                                                                                                        |
| `POST /api/build/edits/curate`            | `{ count }`: 409 unless the hand edits are that many now; else `catalog edits --curate`, then `catalog build`, as one local job (the build keeps what the edited files hold)                                                                                                                            |
| `GET /api/build/undo[?n=]`                | `CatalogUndoView`: the builds kept, newest first, numbered 1 (the latest) to 5 as `catalog undo` numbers them, and the plan to take back the `n` latest (the builds it takes back, each file restored or removed)                                                                                       |
| `POST /api/build/undo`                    | `{ n, files }`: 409 unless taking back the `n` latest builds is that many files now; else `catalog undo <n> --yes` as a local job                                                                                                                                                                       |
| `GET /api/build/prune`                    | `CatalogPruneView`: exactly what `catalog prune --json` lists                                                                                                                                                                                                                                           |
| `POST /api/build/prune`                   | `{ count }`: 409 unless the list is that many now; else `catalog prune --yes` as a local job                                                                                                                                                                                                            |

`POST /api/scan` takes `allowRemovals` and `discardEdits` (passed to `atticus scan`), and its job's result carries `sources` (the scan's `--json` `sources`) whether it wrote or was refused. Every write is one local job at a time (409 while Apply, Propose, Bring in or another runs), and changes only the metarepo's files or this machine's undo folder.

**The pages.** Map › Trust › Readers found / facts say (`ui/src/screens/map/CrossCheck.tsx`, `#/crosscheck?repo=&show=`), linked from Trust (the page and each repo read) and Set up › Scans; Set up › Scans › Catalog builds (`ui/src/screens/setup/CatalogBuild.tsx`, `#/catalog-builds`). Both have their loading, error and empty states, and the cross-check its no-facts, no-readers-slot, legacy, unusable and all-agree states; the confirm dialogs (`ConfirmDialog`) take the focus, keep Tab inside, close on Esc and give the focus back; removals and discards ask for the count to be typed. Lists and tables wrap (and tables become rows under 560 px), so the pages fit VS Code's panel at 780 and 420 px without scrolling sideways (journey 35 checks both, with axe).

**Promote to assert** (point 3; `scanner/src/crosscheck-promote.ts`, `atticus catalog crosscheck <repo> --promote <key>`). `planPromote` makes, from the reader's record and nothing else, one fact in the facts file's own shape (ADR 0124's schema, unchanged: `by: person` and `verified: none` were always in it), with id `person-<kind>-<12 hex of the key's SHA-256>` (the same key, the same id), `commit` the reader's, and `cite` the reader's line: a code line first (`evidence.source: code`), so an endpoint the controller and the OpenAPI file both say cites the controller. `value` is what the verifier looks for there (the path, the topic, the key or its last segment when only that is on the line, the column's name), and `quote` the line's text, read from the base clone (files only) only when its HEAD is the reader's commit. The kinds one fact says whole: an Endpoint is an `entry`; an Interface a `call` (`via` gives `callType`: direct, gateway and mesh `rest`, event-bus and pubsub `event-topic`, mq `mq-queue`, sftp, webhook; `to` and `sync` as the record says); a Setting a `config` fact (a reference as `source`, else `value`); a Column a `field` of the facts' own store fact for its table (refused when the facts have none); an Unresolved event-publish a `call` and event-subscribe an `entry` (`event-topic`). Any other kind is refused with why. The fact is appended to `facts/<repo>.jsonl` (an edit to propose, ADR 0190), started from the facts snapshot when the file isn't there; a fact of that id with the same claim is "promoted already" and writes nothing, one with another claim refuses. The command is a person's (`ai/src/person-only.ts`, refused in a Copilot session) and keeps the run log; the app's job runs it and then `atticus verify <repo>`, and `promotedStates` reads where the fact stands for the item (`written`, `verified` when the facts file has it `verified: line`, or `rejected` from `<repo>.rejected.jsonl` with the code and message). `cli/test/crosscheck-promote-cli.test.ts` shows it on the Forge estate with its clones: the promoted endpoint is verified on its line, `verify --write` projects it, and the cross-check then agrees on it.

**The upgrade as a confirm step** (point 6). Catalog builds loads `GET /api/build/upgrade` when `GET /api/build` says `upgrade`, and shows each slot and its records, the copy in `generated-before-upgrade/`, the first build's changes (none, else no confirm and the list), the repos whose facts could be verified, and every file it writes with its kind and size; the confirm asks for the count of files and sends the listing's `plan`. `atticus upgrade` runs its other steps first and plans the slots step again after them (they may change an input the slots record), so while any other step waits the confirm is refused and the page offers Home's **Run the upgrade** (`POST /api/upgrade`, `atticus upgrade` without `--yes`), which runs them and only shows the slots step: what the person confirmed is exactly what `--yes` writes.

**The last build's report** is CS2's `readBuildReport` (`.index/build-report.json`, written by every build but a check, a refusal and a stopped write included), so Catalog builds shows a terminal's refusals too, with the commands that go on (`run`). Each removal gives `inputs` when a build input other than a slot explains it (from the build's words `an input changed (<path>)`: `answers` for the questions folder, `pairings`, `org-pack`, `curated`, `traffic`, `shared`, `inputs`, `proposals`, `federated`, `other`), and the page names an answer's as the person's own action (the owner's decision of 2026-11-11).

**The kept reads.** The routes no longer forget the server's kept catalogs themselves: every build and look goes through `loadBuildInputs`, which calls `forgetKeptReads()` first, and `guardBuild` reads `catalog/generated` fresh. The curate-then-build job keeps its test (`cli/test/ui-api-catalog.test.ts`, with the server's kept catalogs on).

**Not built here.** IntelliJ's tool window loads the same pages from the server; it was not run here.
