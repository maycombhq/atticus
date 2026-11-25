# v33 notes: item 11, the two slow steps of an Apply

What the shared files should say for the `b33/item11-speed` branch. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## What was measured

`packages/cli/test/apply-speed.test.ts` generates the estate at test time in a temporary folder (`makeBigEstate` of `big-estate.ts` with small repos: 45 services and 15 gateway proxies, 60 repos, 13,508 record files; the owner's 41 repos had 12,846) and writes an `inputs/` folder of 30 partner OpenAPI specs (120 operations each, 24 titled by a Forge service, 6 by nobody) and 30 draw.io diagrams (200 boxes each, most naming a service). After a cold build it runs two Applies of one changed repo (`writeFactsIntoCatalog`, as `verify <repo> --write` and the app's Apply do) and prints every phase on `buildPhases`' clock with the files the guards' hash opened. Its numbers on this build machine (2 shared CPUs, Linux, load 2 to 6), each the first Apply after the cold build and then a steady one:

| Step                                                        | Before (main 7edc41d8) | After                   |
| ----------------------------------------------------------- | ---------------------- | ----------------------- |
| The guards' hash (`hash:` and `guards: build.json read`)    | 0.25 to 0.30 s         | 0.20 to 0.40 s          |
| Files the hash opened, first Apply after the build / steady | 13,508 / 13            | 13,508 / 13 (unchanged) |
| The intake (`build: 3 intake, and the merge again`), steady | 2.34 to 2.58 s         | 0.60 to 0.80 s          |
| of which names and readers                                  | 1.28 to 1.44 s         | 0.44 to 0.50 s          |
| of which read, hash and classify; defences                  | 0.21 to 0.25; 0.37 s   | 0.01; 0.00 s            |
| of which partner specs (conflicts with code)                | 0.30 to 0.32 s         | 0.02 s                  |
| The whole steady Apply                                      | 6.2 to 6.6 s           | 3.8 to 4.4 s            |

The guards' hash was not slow here: hash-cache.ts (beta.28.5) keeps each record file's hash by its size, time, change time and identity, so a steady Apply opens only the files the last one wrote (13 of 13,508). It opens every file only when the kept hashes are missing: the first Apply after a build that wrote every file (a cold build, an upgrade), whose new files are inside the racy window when it ends. Where the owner's 21.9 s comes from is not found on this machine; see Open.

## What changed

- **The intake's lookups read the catalog once.** `resolveNames` read every record for each name (a diagram's box, a spec's title): `nameResolver(records, systems)` in `packages/reconcile/src/aliases.ts` builds the ids, components and aliases once and remembers each name's answer; `resolveNames` is it over a list, unchanged. The partner specs' check against the code looked up each operation, and each spec's calls, by reading every record: the code endpoints and the sync calls are now put in two maps once (`scan-inputs.ts`), in the records' order, so the triage is the same.
- **An input that didn't change isn't opened.** Each intake keeps, per metarepo and inputs folder, what it took in of each file (its bytes, its class, ADR 0042's screening) with its stat; the next intake in the same process (the app's server, `verify --all --write`) stats the file and reads, classifies and screens it again only when the kept hashes' rule (`keptHolds`) says the stat no longer holds it. Antivirus scans a document at each open; a stat it doesn't.
- **The kept hashes on a Windows laptop (review of PR #22).** Three ways every Apply could read every record file again although none changed, each fixed in `packages/core/src/hash-cache.ts`:
  - The cache was written by a rename over its last file, which antivirus can hold (1 to 2 MB of JSON); the failed write was swallowed, so the next run had no hashes. Each generation is now a new file (`hashes-<key>.<n>.json`, made with `wx`), the newest that reads is read (one cut short leaves the one before), older ones are deleted when they can be. A write that fails is told (`hashCacheHooks.onWriteFailed`), and `atticus selfcheck --timing` makes and removes a file in `.atticus/cache` and says so when it can't (`hashCacheWriteProblem`; `hashCacheWrite` in `--json`).
  - A file whose change time alone moved (OneDrive, a backup, Git's autocrlf move NTFS's ChangeTime, not the bytes) was hashed again on every run while the change was under 2 s old at the hash. It is hashed once and kept with its new change time: the change time is racy only within 100 ms of the hash (a file system clock's lag; 2 s when it is a whole second, a file system that keeps seconds), the modification time within 2 s as before (`keptHolds`). A same-size edit that put the file's time back is still read: any write moves the change time, which is in the key.
  - The cache was keyed by the folder's path as given: VS Code says `c:\`, a terminal `C:\`. `cacheDirKey` makes the drive letter upper case (the kept parses, record-cache.ts, too).
- `selfcheck --timing` lists the hash's own phases (`hash: walk`, `hash: read and sha256`) before its total.
- No contract, no copy file change (selfcheck's words are in `TIMING_WORDS`), no surface.

## What the owner runs on his Windows machine

In the metarepo, with nothing else running against it:

```
atticus selfcheck --timing --names
```

Read three lines: `hash: walk` and `hash: read and sha256` (where the guards' seconds go), "The guards' hash read N of M record files again" (N near M means the kept hashes don't hold there: run it twice; the second should say a few), and whether it says "The guards' hash couldn't keep what it read (E…)" (something holds or blocks `.atticus/cache`). The intake's phases are in the same list (`intake: read, hash and classify`, `intake: names and readers`).

## CHANGELOG.md (beta.33, Fixed)

- **The intake of each Apply, about 3 times faster.** It looked up each diagram box, spec title and spec operation by reading every record of the catalog: 2.3 to 2.6 s of each Apply on a generated estate of 60 repos and 13,500 records with 60 documents in inputs/, now 0.6 to 0.8 s. The catalog is read once an intake, and a file of inputs/ that didn't change isn't opened, classified or screened again by the same process (the app, `verify --all --write`). What the intake makes is unchanged.
- **The guards' hash kept what it read on Windows less often than it could.** Its cache is written as a new file each time, never renamed over the last (which antivirus can hold); a file whose change time alone moved (OneDrive, a backup, autocrlf) is hashed once, not on every Apply; `c:\` and `C:\` share one cache. `atticus selfcheck --timing` shows the hash's own phases and says when the cache can't be written.

## docs/build-status.md

The two slow steps of an Apply (2026-11-25; item 11 of `docs/plan/ai-first.md`; no ADR, no contract change). **Works:** the intake's name, spec and call lookups read the catalog once (`nameResolver`; the code endpoints and sync calls by key); an unchanged input not opened again in the process (kept per metarepo and inputs folder by its stat, `keptHolds`); the kept hashes written as a new generation each time, a failed write told and said by `selfcheck --timing`, a change-time-only change hashed once, the drive letter's case one key (`cacheDirKey`); `selfcheck --timing`'s `hash:` phases. Tests: `cli/test/apply-counts.test.ts` (in `pnpm test`, 8 repos: a steady Apply opens only what the last wrote, reads no unchanged input, reads the catalog once an intake; a same-size hand edit with its time put back refused, a CRLF-only change not an edit), `cli/test/apply-speed.test.ts` (`pnpm test:speed`, 60 repos, guards' hash and intake under 3 s), `core/test/hash-cache.test.ts` (change time, drive letter, generations, a failed write), `cli/test/selfcheck-timing.test.ts`, `intake/test/defences.test.ts`. **Open:** see the notes.

## docs/codebase-map.md

| What                                     | Where                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Names resolved with the catalog once     | `packages/reconcile/src/aliases.ts` (`nameResolver`, `resolveNames` over it), used by `intake/src/scan-inputs.ts`                             |
| An input file's class and screening kept | `packages/intake/src/scan-inputs.ts` (`byBytes`, by path and sha-256, the last intake's files only)                                           |
| The speed test of an Apply (item 11)     | `packages/cli/test/apply-speed.test.ts` (estate: `big-estate.ts` with small repos and an inputs/ it writes; `ATTICUS_APPLY_REPOS` for a size) |

## Open, for the next step

- **The owner's 21.9 s is not reproduced on Linux.** The three causes above are the likely ones on a Windows laptop; his `selfcheck --timing --names` (above) says which, if any, is left. Windows CI runs `apply-counts` (the count of files a steady Apply opens) and the hash-cache tests.
- **The first Apply after a full build opens every file** (13,508 here, 0.3 s; seconds under antivirus): a build's files are racily new when it ends. Not changed: a missed hand edit is worse than a slow first Apply.
- No Apply prints a timing line, so a failed cache write is said by `selfcheck --timing` only (and told to `hashCacheHooks.onWriteFailed`).
- The kept parses (record-cache.ts) still rename over their file (`writeFileAtomic`, quick tries): a held file costs the next run its parses, not its hashes.
- What is left in the intake is reading the specs and diagrams (about 0.45 s; each spec parsed twice, `readOpenApiSpec` and `readVendorSpec`; each diagram twice, `readDrawio` and the draw.io ingestor) and the second merge (about 0.15 s). An input kept in the process holds its bytes in memory.
- **Size budget.** `scripts/check-size-budget.mjs` was over before this change (+1,224 over on the base); this change adds about 170 non-test lines (now +1,396 over).
