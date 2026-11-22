# 0205. One repo's Apply in fifteen seconds: what was measured, and what is reachable

- Status: accepted (2026-11-19, by the owner, with the three recommended answers: the 15 s is for the field-shaped estate at up to 60 repos, as a CI budget, and the big estate's times go in the release notes as a stress test; "done" is shown while the caches are written under the lock (step 2); the app may hold up to about 1 GB more for its caches at 100,000 records, let go after ten idle minutes or when memory runs low (step 4); built in beta.30, with the step first held back built too (the owner's decision of 2026-11-21: nothing stays out of beta.30), as "As built" says; the addendum of 2026-11-21, incremental global passes: proposed)
- Date: 2026-11-19 (proposed and accepted)
- Release: 2.0.0-beta.30, slice 10 ([the plan](../plan/v30.md))
- Builds on: ADR 0195 (point 9 and its addenda of 2026-11-12, 2026-11-13 and 2026-11-15), ADR 0197
- Contracts: none. C1 to C6 and the facts file are unchanged, and so is every committed file (`catalog/generated`, `catalog/sources`, `build.json`). Only local, git-ignored caches change: the build cache (`.index/build-cache/`, which gains `facts/<key>.v8`) and the parse cache. `BUILD_CACHE_FORMAT` stays 2 (this note first said it would go to 3): the code's stamp (`codeStampOf`) is in every key and header the cache writes, and any change to the code that runs changes the stamp, so a cache another Atticus wrote is never read whatever its format number says; the number is for a change of shape the same code must tell apart, and there is none. No migration: an old cache is no cache.

## Context

One repo's Apply is `atticus verify <repo> --write`: the app's Apply runs it in the server's own process (`POST /api/facts/{repo}/apply`, `packages/cli/src/ui-api.ts:931`), and the command runs it in a process of its own. It checks the repo's facts on their lines, then builds the whole catalog from every slot, guards the build, writes it, and writes the repo's contracts, specs, questions and map (`writeFactsIntoCatalog`, `packages/cli/src/map-render-commands.ts:639`).

The goal of 15 seconds has been open since beta.28.1. beta.28.2 measured one repo's Apply at 60 repos (about 104,000 records) at 49 s, 65 s before ADR 0197. It found the next step it had planned, incremental features and glossary, infeasible: in that estate every flow visits every service, so every flow changes when any repo does (ADR 0195, addendum of 2026-11-15). The plan says slice 10 may not reach 15 seconds and that this note says what is reachable before any code is written.

This note measures first. Its answer, in short:

- **On the field-shaped estate** (the shape of the owner's estate, about 290 records a repo), one repo's write takes 5.3 CPU s at 60 repos, and the Apply as a command 8.3 CPU s. On this machine at a load of 10 the write took 10.6 to 12.4 s and the command 13.6 to 17.7 s (median 15.5 s); on an idle machine that is about 5 to 8 s, under 15 s already. The design takes about 1 CPU s more off.
- **On the big estate at 30 repos** (50,296 records), it takes 19.9 CPU s, and 17.5 s on the clock at the quietest moment measured (load 4). The design takes it to about 16 CPU s, which is about 15 s on an idle machine like this one and more under load.
- **On the big estate at 60 repos** (100,407 records), it takes 43 to 45 CPU s. The design takes it to about 33 to 36 CPU s. **15 s is not reachable there** with changes that can be proven to give the same bytes. The passes over the whole estate, the record texts and the hash of every record file take 22 CPU s at that size with nothing else, and none of the passes can be patched for a one-repo change and proven equal (see "What a one-repo change can invalidate").

## What was measured

### How

- **Estates.** Both invented, from `packages/cli/test/big-estate.ts` and `field-estate.ts`, built cold, then written.
  - The big estate: N service repos and N/2 gateway proxies (`ATTICUS_BENCH_REPOS=30 ATTICUS_BENCH_GATEWAYS=15`, and 60 and 30), each service with 360 entries, 220 calls, 40 tables and 300 settings.
  - The field-shaped estate: the shape of the owner's field report of beta.28.3, made at 30 and 60 repos in all, 3 in 8 of them gateway proxies (19 services and 11 proxies; 38 and 22). It has 6,000 field names as glossary terms, legacy services, 240 open questions, hand pairings and suppressed arrows.
- **Harness.** `packages/cli/test/big-estate-bench.test.ts` and its phase clock (`buildPhases`), with four additions made for this note (test code only, skipped unless `ATTICUS_BENCH=1`): `ATTICUS_BENCH_FIELD=1` for the field-shaped estate, `ATTICUS_BENCH_RUNS` for the number of writes, the peak memory and the load average with each timing, and `ATTICUS_BENCH_CLI` and `ATTICUS_BENCH_ONE` to run each Apply in a process of its own: the command, or `packages/cli/test/bench-one-write.mjs`, which runs the write (or, with `--verify`, `verifyCommand` as the app does) and prints its phases.
- **What a run is.** One repo (`forge-svc-01`) changed, then written. Each figure is the median of three runs unless it says otherwise, after a first write that the note leaves out (it fills the parse cache, see below). CPU time is the process's, every thread's. Wall time is on the clock.
- **The machine.** 2 CPUs and a memory limit of 6.3 GB, both shared with other sessions' builds, type checks and browser tests. The load average was 4 to 33 during the runs, and is given with every timing. Under this load the clock ran 1.4 to 3 times the CPU time, and at 60 repos two runs in three were killed for memory until the runs waited for the memory to be free. **CPU time is the figure to compare.** On an idle 2-CPU machine the clock is about the CPU time or a little under it, since the hashing threads and the garbage collector's helpers use the second core: at a load of 4, a write of 19.7 CPU s took 17.5 s.
- **Profiles.** `node --cpu-prof` of one write at 30 repos and one at 60 repos, read for each function's inclusive time.

### One repo's Apply, whole

| Estate                                        | Records | In one process: the write, or as the line says                               | Apply as a command, its own process                               | Peak memory |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| field-shaped, 30 repos                        | 10,219  | 2.7 CPU s; 4.5, 5.4, 8.7 s (load 13)                                         | 5.2 CPU s; 7.6, 9.4, 10.8 s (load 7 to 8)                         | 1.1 GB      |
| field-shaped, 60 repos                        | 17,179  | 5.3 CPU s; 10.6, 10.9, 12.4 s (load 10)                                      | 8.3 CPU s; 13.6, 15.5, 17.7 s (load 10)                           | 1.5 GB      |
| big, 30 repos and 15 proxies                  | 50,296  | 19.9 CPU s; 49.6, 51.5, 56.5 s (load 13 to 15)                               | 22.6 CPU s (four runs, 21.7 to 24.0); 52 to 111 s (load 25 to 33) | 1.4 GB      |
| big, 30 repos: the write again, quieter       | 50,296  | 18.7 CPU s; 26.0, 29.1, 35.1 s (load 5 to 7)                                 |                                                                   | 1.4 GB      |
| big, 30 repos: `verifyCommand` in one process | 50,296  | 19.9 CPU s (four runs, 19.7 to 20.6); 17.5, 29.6, 29.8, 39.6 s (load 4 to 8) | (the same as the app runs it, with verify's own check)            | 1.4 GB      |
| big, 60 repos and 30 proxies                  | 100,407 | 43.3 CPU s; 127.2, 129.2, 129.5 s (load 14)                                  | see the next line                                                 | 2.8 GB      |
| big, 60 repos: `verifyCommand` in one process | 100,407 | 45.4 CPU s; 59.0, 61.8, 73.7 s (load 6 to 7)                                 | (the same as the app runs it, with verify's own check)            | 2.7 GB      |

- "The write" is `writeFactsIntoCatalog`, each in a fresh process at 30 and 60 repos of the big estate and in the bench's process for the field-shaped one. It is what the app runs after verify's check of the facts, which takes about 1 to 2 CPU s for a repo of 400 to 2,400 facts and doesn't grow with the estate.
- The command adds starting Node and loading the CLI, verify's check, and caches read cold: 3 CPU s on the field-shaped estate.
- **The first write after a cold build** at 60 repos took 92.7 CPU s and 280 s (one run, load 16): reading the catalog took 38 CPU s because the parse cache was empty. At 30 repos it took 35.5 CPU s. The first write after an upgrade (another build cache's version) took 45 and 75 CPU s at 30 repos (two runs, load 12 and 26). None of these is the steady case, and none is what this note designs for.
- **The cold build** at 60 repos took 59.8 CPU s and 192 s (load 18 to 29), 1.9 GB.

### Each phase of the write (CPU s, median of three)

The field-shaped estate's phases were printed to 0.1 CPU s. "Outside the build" is the part of "the projection" step that is not a pass of the build: the comparison with the catalog on file, the other repos' facts read for the questions' suggestions, the questions.

| Phase                                                               | field, 60 | big, 30  | big, 60  | 30 to 60 |
| ------------------------------------------------------------------- | --------- | -------- | -------- | -------- |
| read the catalog before the build                                   | 0.7       | 1.37     | 2.53     | ×1.8     |
| read the slots (every repo's facts parsed)                          | 0.2       | 0.77     | 1.49     | ×1.9     |
| the build cache's key and lookup                                    | 0.1       | 0.25     | 0.92     | ×3.7     |
| pass 1, each repo's source                                          | 0.0       | 0.20     | 0.44     | ×2.2     |
| pass 2, the facts projected and the estate join                     | 0.6       | 2.17     | 3.49     | ×1.6     |
| pass 2, the joins applied                                           | 0.1       | 0.39     | 0.94     | ×2.4     |
| pass 3, the merge                                                   | 0.3       | 1.41     | 2.09     | ×1.5     |
| pass 3, the features                                                | 0.3       | 2.05     | 9.30     | ×4.5     |
| pass 3, the glossary                                                | 0.4       | 0.92     | 1.44     | ×1.6     |
| passes 4 to 7 (link evidence, legacy, curated, per repo)            | 0.1       | 0.20     | 0.32     | ×1.6     |
| pass 8, the record texts and build.json                             | 0.3       | 1.43     | 3.61     | ×2.5     |
| outside the build: the comparison, the estate's facts, questions    | 0.6       | 2.35     | 4.43     | ×1.9     |
| hash every record file (kept hashes, 2 worker threads)              | 0.3       | 0.81     | 1.43     | ×1.8     |
| the guards                                                          | 0.4       | 0.99     | 1.80     | ×1.8     |
| the report                                                          | 0.1       | 0.09     | 0.19     | ×2.1     |
| keep the build (the build cache written)                            | 0.3       | 1.04     | 2.29     | ×2.2     |
| write the catalog (undo copy, record files, build.json)             | 0.1       | 0.45     | 0.63     | ×1.4     |
| the catalog after the write (the written texts parsed, for the map) | 0.2       | 1.24     | 2.28     | ×1.8     |
| the parses kept (the parse cache written)                           | 0.1       | 0.21     | 1.21     | ×5.8     |
| contracts, specs, flows, questions, report                          | 0.4       | 0.59     | 1.22     | ×2.1     |
| the map                                                             | 0.1       | 0.53     | 0.78     | ×1.5     |
| **the write**                                                       | **5.3**   | **19.9** | **43.3** | **×2.2** |

The records double from 30 to 60 repos and the write grows 2.2 times. The features grow 4.5 times, as ADR 0195 said: in this estate every flow reaches every service, so the work is the number of entry points times what each reaches. The two caches written whole each time (the build cache, the parse cache) grow faster than the records too.

**The profile** of a write at 60 repos (main thread, sampled every 2 ms, 76.8 s sampled for 42.8 CPU s; inclusive, in sampled seconds, so each figure is about 0.6 CPU s per second):

| Function                        | Sampled s | What it is                                                           |
| ------------------------------- | --------- | -------------------------------------------------------------------- |
| the garbage collector           | 17.2      | 22% of the samples, spread over every phase: a heap of 1.3 to 2.1 GB |
| `featuresForScan`               | 8.4       | pass 3                                                               |
| `serializedOf`                  | 4.6       | pass 8: each record's JSON, its hash, its text                       |
| `factsEstateRecordsSteps`       | 4.0       | pass 2 (`factsRecords` 1.6, `joinFactsSteps` 2.0)                    |
| `parseFacts`                    | 3.5       | every facts file parsed: the slots, then the estate's facts again    |
| `diffCatalogs`                  | 3.3       | every record of the build compared with the catalog on file          |
| `catalogAfterWrite`             | 2.4       | the written texts parsed (the features' files are large)             |
| `guardBuild`, `glossaryForScan` | 2.3 each  |                                                                      |
| `mergeCatalog`                  | 1.7       |                                                                      |
| `keepBuild`, `renderMap`        | 1.4, 1.3  |                                                                      |
| `estateFacts`                   | 0.7       | the other repos' live facts, for the questions                       |

**A larger young generation** (`--max-semi-space-size=64`) was measured at 60 repos against the GC's share: 42.3 CPU s (42.2 to 42.9) against 43.3 (42.4 to 44.0). Within the spread, so the collector's time is the old generation's, a heap of 2 GB, not short-lived garbage. It is not proposed.

### The top five costs (the big estate at 60 repos, CPU s of 43.3)

1. **The features pass: 9.3 s (21%).** It grows with the square of the estate here. It is the work itself, not work done again (ADR 0195, addendum of 2026-11-15).
2. **Comparing the build with the catalog on file: 5.8 s.** 2.5 s to read the catalog before the build, and about 3.3 s for `diffCatalogs`, which compares every one of the 100,407 records field by field to report the 200 or so that changed.
3. **The local caches, read and written whole: 4.4 s.** Keep the build 2.3 s, the parse cache written 1.2 s, the build cache's lookup 0.9 s. All three are written before the Apply says it is done.
4. **The facts projected and the estate join: 4.4 s** (3.5 s and 0.9 s for the joins applied).
5. **The record texts and build.json: 3.6 s**: each record's JSON made and hashed to find its kept text.

Next: the catalog after the write 2.3 s, the merge 2.1 s, the guards 1.8 s, the facts parsed 1.5 s (and again for the questions), the glossary 1.4 s, the hash of every record file 1.4 s, the contracts and questions 1.2 s.

## What a one-repo change can invalidate (from the code)

Can the last build's results be reused for the repos whose inputs didn't change? Pass by pass, from `buildCatalog` (`packages/scanner/src/build.ts:937`):

- **Pass 1, each repo's source.** Only the changed repo's line. It costs 0.4 s; there is nothing to save.
- **Pass 2, the projection of each repo's facts** (`factsRecords`, `packages/scanner/src/facts-catalog.ts:1185`) is a pure function of the repo's facts, its targets from the answers, the org pack and the component renames. The renames (`componentRenames`, `facts-catalog.ts:1129`) are worked out over every repo: a component id two repos share is renamed in both. So a change of one repo can change another repo's projection only through a rename, and the projection of a repo can be kept by the hash of exactly these inputs. **This one is provable.** It saves at most about 1 CPU s at 60 repos (`factsRecords` is 1.6 sampled seconds), and only in a process that keeps it in memory: read back from a file, 100,000 records cost about what projecting them does.
- **Pass 2, the estate join** (`joinFacts`, `packages/core/src/facts-join.ts:1102`) is global by nature. A call in any repo is matched with the entries of the repo whose host it names, then by its path across every entry the estate has (the fallback, where an ambiguity counts every entry that serves the path), through each gateway's routes, and each publish with every listener. A change to one repo's entries can change the joins of calls in every repo. Patching it would need the join to report, for each call, every entry it looked at; it doesn't, and a list that missed one would give an arrow a build from scratch doesn't. **Not provable; out.**
- **Pass 3, the merge** joins records across repos by key, host, route and system; **the features** trace from every entry point through every call that shares a word (in the big estate every flow visits all the services); **the glossary** counts each word over the whole catalog and cites the first use in each repo. beta.28.2 tried each and found that a cache by one repo's inputs misses on every write that changed code. That still holds; this note found nothing new that changes it. **Out.**
- **Passes 4 to 7** read the whole join (link evidence) or every record (the legacy overlay, the curated decisions), and cost 0.3 s together.
- **Pass 8** already reuses each record's text by the hash of its JSON. Making the JSON is the comparison, so it can't be skipped without trusting that a record is unchanged.
- **The guards** compare every record file's hash with build.json's, 1.8 s. Since beta.28.5 a file whose size, time, change time and identity are the ones its hash was kept by isn't opened again (`packages/core/src/hash-cache.ts`), so most of the 1.4 s of the hash is 100,000 stats and the kept hashes read.
- **The index.** Apply doesn't build it: the index is opened when a map tool or `atticus ask` needs it (`openIndex`, `packages/index`). There is nothing to skip.

So the only reuse that can be proven inside the passes is pass 2's projection per repo, worth about 1 s at 60 repos and only in the app's process. What can be cut with a proof is around the passes: work that compares, parses and caches the whole catalog to find or keep the part that changed.

## Decision

Four steps, in this order. Each keeps every committed file byte for byte what a build from scratch writes, with the cache on or off. The expected savings are CPU s for the field-shaped estate at 60 repos, then the big estate at 30 and at 60 repos.

### 1. Compare only the files whose text changed

`projectFactsIntoCatalog` calls `diffCatalogs(existing, build.records)` over the whole catalog to report what the write changes (`map-render-commands.ts:596`). Instead, the write compares only the records whose file it adds, changes or removes, and does it after the guards' hash, which already gives every file's hash:

- A file whose text is the text on disk byte for byte holds the same record: the same bytes give the same parse. `diffCatalogs` has nothing to say about it.
- The records compared are the parse of the file on disk (the catalog read before the build has it) and the parse of the text written (`catalogAfterWrite` has it). The full comparison today compares the parse on disk with the build's record in memory.
- `linkChanges` reads only Interfaces and keeps its inputs as they are.

**Saving:** about 0.4, 1.7 and 3.0 s. By the profile, about four fifths of the 4.4 s outside the build at 60 repos is `diffCatalogs`; comparing the 200 or so changed records is left.

**Proof:** the equivalence tests (below) compute the comparison both ways after every write and require the same lists, in the same order. The two can differ only where a record's parse and the record in memory differ although its text is the same, and then today's comparison reports a change no file has. If a test finds one, that is the step's answer: the step is held back and the difference is reported to the owner, not shipped.

### 2. Write the local caches after the result

Keeping the build (`keepBuild`), the parses of the written files (`keepWrittenParses`) and the hash cache's memo happen today before the write says it is done (`buildAndWrite`, `packages/scanner/src/build.ts:3805` and `:3852`). They are written after it instead: the app's job reports its result and then writes them, still under the lock; the command prints its lines and then writes them before it exits. The next Apply waits for the lock as it does now.

**Saving** in the time to "done": about 0.4, 1.25 and 3.5 s. The CPU used is the same; it moves after the result.

**Proof:** a cache never changes a byte. The build cache's tests already compare every field of a cached build with one built with the cache off (`build-cache.test.ts`, `build-cache-keys.test.ts`), and the property tests build from scratch with no cache. A cache that isn't written (a Stop, a crash after the result) is no cache: the next build is slower and the same.

### 3. Each facts file parsed once for its bytes

Every write parses every repo's facts slot (`readSlots`, 1.5 s at 60 repos), then reads every repo's live facts file again for the questions' suggestions (`estateFacts`, 0.7 sampled s). A facts slot is a copy of the live file at its last successful write, so for every repo but the changed one the bytes are usually the same.

Each facts slot's parse is kept in the build cache by the SHA-256 of its bytes and the build's version, as each readers slot's already is (`readers/<key>.json`). ADR 0195 point 9 asked for each slot's projection to be kept by the hash of its bytes; only the readers slot's was built. `estateFacts` takes the slot's parse for a live file with the same bytes.

**Saving:** measured at 60 repos, parsing every slot takes 1.0 to 1.1 CPU s and reading the same parses back from the cache's encoding (`v8.deserialize`) 0.37 to 0.54 s. About 0.1, 0.4 and 0.7 s in a process of its own, and up to 1.5 s in the app's process, which keeps them in memory (step 4).

**Proof:** `parseFacts` is a pure function of the text, and the cache is keyed by the hash of the text, so it returns the parse of the same bytes. The cache's tests: one byte changed misses, the same bytes hit, an unreadable entry is ignored, and a build with the cache off writes the same files.

### 4. The app keeps its caches in memory between Applies

The app's server runs every Apply inside its own long-lived process, yet each write reads the build cache (0.9 s), the parse cache (most of the 2.5 s of "read the catalog") and every facts file back from disk, because CS3 forgets what the server kept before a writer builds (`forgetKeptReads`, `build.ts:411`). Each is kept in the server's memory instead, with the key it has on disk: the build by the build's key, a record's parse by its file's size and time (as the parse cache on disk is today, which the owner accepted for reads, not for the hand-edit guard), a facts parse by the hash of its bytes. The guards still read and hash every record file. CS3's rule holds: nothing is built from a kept copy that its key doesn't vouch for.

**Saving,** in the app only: about 0.3, 1 and 2.5 s.

**Cost:** the server holds the last build and the catalog's parses, about 0.5 GB more at 50,000 records and 1 GB at 100,000. It lets them go when the server is idle for ten minutes, or when the memory limit is near.

**Proof:** the same keys and the same checks as the files they stand for. The tests run two Applies in one server and the same two as commands, and compare every file; and change a record file by hand, a facts file, the org pack and a curated decision between them.

### Not proposed

- **A larger young generation for the collector:** measured, no gain (above).
- **The projection per repo kept by its inputs** (pass 2, provable): about 1 s at 60 repos, in the app only. Left for after beta.30; it is the one reuse of a pass that can be proven.
- **The estate join, the merge, the features and the glossary patched for a one-repo change:** can't be proven equal (above).
- **Hashing the record files while the build runs** (it reads only `catalog/generated`): 1.4 s at 60 repos off the clock on a machine with a spare core. But the hand-edit guard would then see the files as they were when the build started, not as they are just before the write. A hand edit made during the build would be written over. Not without the owner's word, and not proposed.
- **The features' traces in worker threads:** a trace reads the graph only, so traces can run apart and be put back in order. About half the features' time is the traces (`traceIx`). On these 2 CPUs, with the graph built again in each worker, it saves nothing; on a machine with 8 cores it might save 4 s of the 9.3 at 60 repos. Not measurable here, so not proposed for beta.30.

## What is reachable in beta.30

These are the estimates made before the steps were built; what they measured is in "As built" below.

| Estate                       | Now (the write; the command) | After steps 1 to 3 (a process of its own) | After step 4 (the app) |
| ---------------------------- | ---------------------------- | ----------------------------------------- | ---------------------- |
| field-shaped, 60 repos       | 5.3 CPU s; 8.3 CPU s         | about 4.4 CPU s; the command about 7.4    | about 4 CPU s          |
| big, 30 repos and 15 proxies | 19.9 CPU s; 22.6 CPU s       | about 16.6 CPU s                          | about 15.5 CPU s       |
| big, 60 repos and 30 proxies | 43.3 CPU s; 45.4 with verify | about 36 CPU s                            | about 33 CPU s         |

- **The field-shaped estate is under 15 s today** on this machine at a load of 10 for the write (10.6 to 12.4 s), and the command is at its edge (13.6 to 17.7 s, median 15.5 s, for 8.3 CPU s). On an idle machine both are about 5 to 8 s, and the steps take about 1 CPU s more off.
- **The big estate at 30 repos** reaches about 14 to 16 s on an idle 2-CPU machine after the steps (today 17.5 s at a load of 4), and 1.5 to 3 times that at this machine's usual load. Not a reliable 15 s.
- **The big estate at 60 repos does not reach 15 s in beta.30.** After the steps, about 33 to 36 CPU s, about that on the clock on an idle 2-CPU machine. The passes over the whole estate (pass 2, the merge, the features, the glossary) take 17.3 s and pass 8 another 3.6 s, and the hash of every record file 1.4 s: 22 s with nothing else at all. Reaching 15 s there needs the features (9.3 s, growing with the square of the estate) and the other passes to be made incremental, which can't be proven equal, or a new way of tracing features, which is a project of its own with the features' oracle tests as its proof.

The release notes give the measured time whatever it is, as the plan says.

## As built (beta.30, 2026-11-21)

The four steps were built as the decision says, each proven to change no byte (below), and then corrected by an independent review, which found no blocker but these gaps, each fixed with its tests written first:

- **Step 1** as designed: `diffCatalogFiles` over the files a write added, changed or removed (`packages/scanner/src/files.ts`), the whole comparison where the read doesn't match the files. In every test the two comparisons gave the same lists in the same order; none differed, so nothing was held back.
- **Step 2, in the app and in the command.** The app's Apply (`POST /api/facts/{repo}/apply`) gives its result and then writes its caches; `atticus verify <repo> --write` (the command line) now does the same: it prints its lines, then writes its caches under the scan's lock, and only then ends (`main.ts`: `cachesAfterResult`, then `settleAfterResult` of that lock). The review found only the app's path did it. Two more corrections:
  - Only a taker of the same lock waits: `runAfterResult(work, { root, name })`, and `acquireLock` waits for the work under the lock it takes (before, every `acquireLock` in the process waited for every writer's caches).
  - Between the result and the caches the writer marks its lock (`LockInfo.phase: "caches"`, `caching()`). A process stopped there left the catalog written whole: the next scan says "The last write (…) wrote the catalog whole, then stopped while it saved its local caches; they weren't saved, so this run may take a little longer. Nothing is missing.", and `atticus doctor` says the same without a warning (`packages/cli/src/lock-words.ts`). Before, it said the last scan "stopped before it finished".
- **Step 3.** A facts file's parse is kept on disk by the text's hash, the code's stamp and **Node's version**: a refused file's issue carries `JSON.parse`'s message, which is V8's wording, and Node's version isn't in the code's stamp. The in-process memo is of one Node.
- **Step 4, the app's memory.** What the server keeps: the last build's record texts (up to 512 M characters, about bytes), core's facts parses (up to 256 MB) and the build cache's facts parses not yet on disk (up to 256 MB, written with the next build), and the writers' catalog parses (below; up to 160 MB of files). `packages/core/src/app-memory.ts` holds the rule, as built after the review:
  - **Ten minutes after the last Apply.** Only an Apply starts them again (`appMemoryApplied`, from the Apply route). Before, every `parseFacts` call did, so a page that read facts files kept everything for as long as it was open. A keeper that keeps with nothing pending starts the ten minutes, and never starts them again.
  - **When memory runs low,** at once: the V8 heap three quarters full, or the machine's or the container's memory nearly used, under a tenth free or 256 MB (`systemMemoryOf`: `os.freemem` and `os.totalmem`, or a cgroup's lower limit, v2's `memory.max` and `memory.current` less its inactive file cache, or v1's `limit_in_bytes` and `usage_in_bytes`; Windows and macOS have no cgroup files; macOS counts its file cache as used, so only the 256 MB floor is low there). It is checked on each use (the system's memory at most once a second) and every half minute on a timer while a server runs, so an idle server lets go too. Before, only the heap was checked, and only when a cache was used. While memory is low nothing more is kept.
  - **When the last server closes.** Outside a server nothing is kept.
  - Each keeper says what it holds (`appMemoryHeld`), which the bench prints.

**The step first held back: the catalog's parses in memory.** This note held it back because `readParsedFiles` hands its parses to its callers without a copy, and the copy a read from disk makes is most of what it costs: keeping them in memory needs every reader to treat them as read-only, which nothing proved. Measured for this (50,000 records, this machine at a load of about 10): the parse cache's file of 47 MB is read back with `JSON.parse` in 0.85 s; a copy of every record kept in memory costs as much or more (per record `JSON.parse` 1.07 s, `v8.deserialize` 1.39 s, `structuredClone` 1.82 s), so a copy saves nothing. The owner's decision of 2026-11-21 was that nothing stays out of beta.30, under the same rules, so it is built this way (`packages/core/src/record-cache.ts`):

- Only a writer's read asks (`readCatalogWithFiles`: an Apply's, a scan's, a build's, `memory: true`), and only in the app's server. A page's read, a preview's and every command outside a server read the parse cache on disk as before.
- The key is the parse cache's own: each parse is vouched for by its file, its size and time, and its hash while it is racy (within the 2 s grain of when it was kept), so any change made outside the app (an editor, `git checkout`, another command) is read again. The record files are the truth; the memo's file on disk is not read.
- What is kept is what the memo on disk gives back (the parse through JSON: no field set to undefined, no -0), deep-frozen, and handed out without a copy. A reader that changed one would throw, not change the next read's. The parses a read makes now are handed to it as they were parsed, as on disk, and kept through JSON for the next.
- A write's own texts are kept as `keepParses` keeps them on disk.
- It is let go by the app's rule and counted in it, and kept only up to 160 MB of the files parsed.

**What the app holds,** measured with the bench after three Applies (`appMemoryHeld`, and the heap after a full collection with it kept and once let go): at 100,407 records (the big estate at 60 repos) core's facts parses count 96 MB, the catalog's parses 58 MB of files, the last build's texts 58 MB, and the build cache's facts parses not yet on disk none (they are written with the build); the heap after a full collection is 0.43 GB with them kept and 0.26 GB once let go: **168 MB held**, a sixth of the owner's 1 GB. At 50,296 records (the big estate at 30 repos) 79 MB, at 17,179 (the field-shaped estate at 60 repos) 23 MB. The peak of the process during an Apply at 100,407 records was 2.9 to 3.1 GB, against 3.1 to 3.4 GB before the steps (the caches it no longer reads back from disk).

### The proof, as built

- **Equivalence on both estates** (`packages/cli/test/apply-15s-equivalence.test.ts`): four writes with every step on (the caches after the result, the app's memory on) and every step off; every file and outcome equal. With the steps on, each comparison is made both ways and must be equal, every kept facts parse is checked against a parse of its text, every kept text against its record's serialization, and every catalog parse taken from memory against its file's parse (`recordCacheHooks.checkMemory`).
- **Property tests** (`packages/cli/test/properties`): two commands, `apply-app` (the app's Apply; the first in a sequence starts the server's memory, so the rest run in a server that kept its caches from an earlier Apply, with every kept text, facts parse and catalog parse checked) and `crash-after-result` (the process stops after its result, before its caches: the lock must be left stale and marked `caches`, and the server's memory goes with it). The master oracle is unchanged, and builds with no cache in memory either. At seed 20261121 (100 sequences of up to 10 commands): passed, `apply-app` acting 12 times and `crash-after-result` 5.
- **The server** (`apply-15s-server.test.ts`): five Applies through the app's route in one server and the same five as commands, with another repo's facts file, a repo's owner in the org pack, a curated suppress and a hand edit changed between them (the Apply refused for the hand edit, its confirm, one more Apply): every file the same bytes after every step, and the same exit codes and refusals.
- **Caches:** `facts-parse-store.test.ts` (another build version and another Node miss), `app-memory.test.ts`, `app-memory-keepers.test.ts`, `record-cache-memory.test.ts`, `after-result.test.ts`, `lock-words.test.ts`, `verify-caches-after-cli.test.ts`.
- **Speed:** `big-estate-speed.test.ts` and `field-estate-speed.test.ts` gain CPU budgets for a steady write at 60 repos (110 and 15 CPU s, about three times the table below), with `ATTICUS_BENCH=1` only; the nightly wall-clock budget (`apply-budget.test.ts`, `ATTICUS_APPLY_BUDGET=1`, `.github/workflows/apply-budget-nightly.yml`) times the app's Apply and the command's, each the median of three, against 15 s. Its runner is GitHub-hosted (ubuntu-24.04), so a slow median with a low CPU time beside it is the runner's noise.

### Measured, before and after

Measured on 2026-11-21 at this branch's code (`d3ae67b0`), on the same 2-CPU machine, shared with four other sessions' builds and tests (a memory limit of about 7 GB). "Before" is the same build with the steps' hooks off (`ATTICUS_BENCH_STEPS_OFF`, `ATTICUS_STEPS_OFF`: the whole comparison, every facts file parsed, the caches before the result, nothing kept in memory), so the two differ only by the steps. Each figure is the median of three, after a first write that fills the caches; the three are in brackets, with the load average (1 minute) of each. The app's Apply is `verifyCommand` with `write` in the bench's process (`ATTICUS_BENCH_APP`), as the server runs it, verify's own check included, timed to its result; as a command, `verifyCommand` in a process of its own (`bench-one-write.mjs --verify`, `ATTICUS_BENCH_ONE`), its CPU time to its end (its caches included), and after, the built command too (`atticus verify <repo> --write`, `ATTICUS_BENCH_CLI`, Node's start and loading the CLI included).

| Estate (records)                       |                 | Before: CPU s; wall s (load)                                    | After: CPU s; wall s (load)                                                                                                                                       | After: the caches after the result |
| -------------------------------------- | --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| field-shaped, 30 repos (10,220)        | the app's Apply | 4.0 [4.6, 4.0, 3.1]; 8.7 [10.8, 8.7, 6.4] (10.3 to 10.8)        | 3.6 [3.9, 3.6, 3.4]; 7.2 [9.0, 7.2, 6.6] (10.4 to 11.2)                                                                                                           | 0.2 CPU s, 0.3 to 0.7 s            |
|                                        | as a command    | 5.9 [5.9, 6.2, 5.9]; 16.2 [13.0, 16.2, 18.5] (10.7 to 11.2)     | 5.4 [5.4, 5.4, 5.1]; 10.1 to its result, 11.1 to its end (9.8 to 10.5); `atticus verify`: 6.1 [5.7, 6.1, 6.3]; 10.2 [8.4, 10.2, 10.6] (9.8 to 10.1)               |                                    |
| field-shaped, 60 repos (17,179)        | the app's Apply | 6.6 [7.4, 5.8, 6.6]; 11.0 [12.4, 11.0, 10.1] (6.8 to 7.3)       | 5.7 [5.7, 6.0, 4.8]; 8.6 [7.9, 8.6, 9.0] (7.7 to 8.7)                                                                                                             | 0.4 CPU s, 0.5 to 1.0 s            |
|                                        | as a command    | 8.5 [8.5, 8.1, 8.8]; 12.9 [11.7, 12.9, 23.9] (6.6 to 8.8)       | 8.0 [8.1, 8.0, 7.9]; 15.7 to its result, 16.4 to its end (8.8 to 9.1); `atticus verify`: 10.0 [9.6, 10.0, 10.3]; 18.3 [14.4, 18.3, 18.5] (7.7 to 8.1)             |                                    |
| big, 30 repos and 15 proxies (50,296)  | the app's Apply | 24.2 [24.2, 23.0, 24.5]; 53.2 [58.6, 50.1, 53.2] (10.0 to 11.2) | 20.5 [18.3, 21.9, 20.5]; 44.0 [38.9, 46.9, 44.0] (8.6 to 10.9)                                                                                                    | 1.5 CPU s, 2.6 to 3.1 s            |
|                                        | as a command    | 23.8 [24.8, 23.8, 22.9]; 47.9 [58.2, 47.9, 44.7] (10.3 to 11.2) | 23.6 [23.6, 24.8, 22.9]; 67.0 to its result, 71.0 to its end (11.5 to 13.0); `atticus verify`: 24.4 [24.4, 23.6, 25.6]; 57.3 [57.3, 53.3, 69.0] (11.7 to 12.3)    |                                    |
| big, 60 repos and 30 proxies (100,407) | the app's Apply | 52.9 [58.0, 52.0, 52.9]; 99.5 [146.8, 84.7, 99.5] (8.9 to 11.4) | 44.3 [50.5, 44.3, 43.1]; 124.4 [124.4, 110.0, 130.7] (10.9 to 12.6)                                                                                               | 3.7 CPU s, 8.9 to 13.9 s           |
|                                        | as a command    | 48.5 [46.8, 48.5, 49.3]; 72.9 [49.6, 72.9, 77.7] (6.0 to 7.3)   | 51.1 [51.8, 51.1, 50.1]; 87.2 to its result, 95.2 to its end (8.4 to 10.4); `atticus verify`: 52.9 [52.9, 53.3, 51.4]; 172.7 [195.8, 172.7, 125.1] (11.0 to 14.5) |                                    |

What it says:

- **In the app, the steps take 10 to 16% of the CPU time off "done":** 0.4, 0.9, 3.7 and 8.6 CPU s on the four estates, and move 0.2 to 3.7 CPU s more after it (the caches). On the field-shaped estate at 60 repos the app's Apply is done in 5.7 CPU s, 8.6 s at a load of about 8: **under 15 s, with room**. This is less than the note estimated before the steps were built (about 1 CPU s more off the field-shaped estate, 33 to 36 CPU s at 60 repos of the big one).
- **As a command, the steps change the CPU time by no more than the load does.** In a process of its own the parses are read back from disk either way; steps 1 and 3 take about 1.5 CPU s off the build and the write at 30 repos of the big estate (its phases: "build and write" 5.4 to 3.9 CPU s, the contracts, specs and questions 1.8 to 0.7), and its caches come after its lines, but the total moved by less than the runs' own spread. The command on the field-shaped estate at 60 repos is 10 CPU s, 18 s at a load of 8: on an idle 2-CPU machine about 10 s, so the nightly budget's command has a margin of about half again, the app's about two and a half times.
- **The big estate at 60 repos takes 44 CPU s in the app and about 51 as a command,** two to eight minutes on the clock at this machine's load of 9 to 14. 15 s is not reachable there with this note's steps; the addendum below says what it would take.
- **Where the load distorted a number.** The clock ran 1.3 to 3.4 times the CPU time; no wall figure here is comparable across columns, and the "after" runs mostly ran at a higher load than the "before" ones (the field-shaped estate's command: 15.7 s after against 12.9 s before at a load of 9 against 7, for 0.5 CPU s less). CPU time moves too, by about 5 to 10% between loads of 6 and 14 on these 2 CPUs (shared caches): the big estate's command at 60 repos ran at loads of 8 to 10 after and 6 to 7 before, which is the 2.6 CPU s it went up. The first attempt at 60 repos of the big estate ran out of memory (the bench's process and the write's own at once) and its "after" runs met the lock the killed one left; they were run again, each kind in a process of its own, and only those are given.

## Risks

- **Step 1 changes what the command says, not what it writes.** If the two comparisons differ on any record, the step waits for the owner (above).
- **Step 2 moves work after "done".** An Apply's Stop after the result leaves the caches unwritten; the next Apply is slower, never wrong. The lock must be held until they are written, or a second writer could build from a half-written cache file: the cache's own atomic writes and its key already refuse a file that doesn't read.
- **Step 4 keeps memory.** On a laptop with 16 GB it is room the server didn't use; on this shared machine it could push other work over the limit. The idle release and the limit check are part of the step.
- **The measurements' noise.** At loads of 4 to 33 the clock moved by up to two times between runs; the CPU times moved by about 5%. The savings above are estimates from CPU time and the profiles, not yet measured; each step is measured with the bench before and after, and its review sees the numbers.
- **The big estate is a worst case.** Every flow reaches every service and every entry has the same four field names. A real estate's features cost less (0.3 s on the field-shaped one at 60 repos). Its budget is a stress test, not the owner's shape.

## Tests that prove it

Written first, failing where they test new behaviour:

- **Equivalence on both estates.** `big-estate-equivalence.test.ts` (three generated big estates) and `map-loop-equivalence.test.ts` (the field-shaped estate) run every write with the steps on and with them off (hooks: the full comparison, the caches written before the result, no facts cache, no memory cache). After each: every file a person or a commit sees is the same bytes, build.json included; the command's lines are the same; the comparison's lists are the same.
- **Property tests.** The CS4 property harness (`fc.commands`, ADR 0195 point 10) gains two commands: a crash after the result and before the caches are written, and an Apply in a server that kept its caches from an earlier Apply. Its master oracle stays: the catalog is the bytes of a fresh build of the final slots with no cache. A fast-check property for step 1: for random catalogs and random one-repo changes, the comparison over the changed files equals `diffCatalogs` over the whole catalog.
- **Cache tests.** `build-cache-keys.test.ts`: a facts slot one byte apart misses, the same bytes hit, another build version misses, an unreadable entry is no entry.
- **The server.** Two Applies in one server and the same as commands give the same files; a hand edit, a facts file, the org pack and a curated decision changed between them each miss the memory cache that reads them.
- **Speed.** `big-estate-speed.test.ts` and `field-estate-speed.test.ts` gain CPU budgets for the write at the measured numbers, about three times over for a slow runner; the bench prints each phase, the peak memory and the load.

## Rough size

| Step                                   | Code (not tests)    | Tests               |
| -------------------------------------- | ------------------- | ------------------- |
| 1. compare only the files that changed | about 80 lines      | 150 lines           |
| 2. caches written after the result     | about 60 lines      | 100 lines           |
| 3. facts parsed once for their bytes   | about 80 lines      | 120 lines           |
| 4. the app's caches in memory          | about 150 lines     | 250 lines           |
| **in all**                             | **about 370 lines** | **about 620 lines** |

## Questions for the owner

1. **Which estate is the 15 s for?** The field-shaped estate is the owner's shape and is under 15 s already on an idle machine (at this machine's load the command is at about 15.5 s); the big estate at 60 repos isn't reachable. Recommended: 15 s on the field-shaped estate at up to 60 repos, as a CI budget; the big estate's 60-repo number (about 35 CPU s after the steps) stated in the release notes as a stress test.
2. **Is "done" the result, with the caches written after it under the lock (step 2)?** Recommended: yes. It takes 1 to 3.5 s off what a person waits for and changes nothing written.
3. **May the app's server keep up to about 1 GB more for its caches at 100,000 records (step 4)?** Recommended: yes, let go after ten idle minutes or near the memory limit; steps 1 to 3 don't need it.

## Addendum of 2026-11-21: incremental global passes for a one-repo change (proposed)

- Status: proposed (the owner asked for this design on 2026-11-21, after the measurements above; no production code is written for it until the owner approves it)
- Aim: one repo's Apply in 15 s on the big estate at 60 repos and 30 proxies (100,407 records), where it takes 44 CPU s in the app and about 51 as a command (the table above) after this note's steps.

### What it would take

The time left at 60 repos is mostly the passes over the whole estate, which this note's steps don't touch (the phase table above, big estate at 60 repos, CPU s): the projection and the estate join 3.5 and the joins applied 0.9, the merge 2.1, the features 9.3, the glossary 1.4, the record texts 3.6. Around them, work that already reads only what changed or can't be cut without trusting a file it didn't read: reading and checking the catalog (the stats and kept hashes of 100,000 files), the guards, the write, the map. 15 s on a 2-CPU machine needs about 12 to 14 CPU s, so about 20 CPU s off: the passes would have to cost a fraction of what they do, for every one-repo change.

A one-repo Apply changes one build input: that repo's facts slot (and its contracts and corrections). Everything below applies only when the build's inputs differ from the last build's in exactly that (the build cache's key, kept per input, says so); any other change (the org pack, a curated decision, an answer, another slot, the manifests, the code's stamp) is a full build, as now.

### Pass by pass, from the code

Each pass's patch keeps the last build's own results in the app's memory (or on disk, as the build cache keeps the last build today) and recomputes only what the change can reach. "What it reads" is from the code, and it is also what the proof checks dynamically (below), so a list that missed something fails a test instead of drawing a wrong arrow.

**1. The projection of each repo's facts** (`factsRecords`, `packages/scanner/src/facts-catalog.ts:1185`). A pure function of the repo's facts, its targets from the answers, the org pack and the component renames; the renames (`componentRenames`) are worked out over every repo, so a change reaches another repo's projection only through a rename it adds or takes away. Patch: keep each repo's projection by the hash of exactly those inputs; recompute the changed repo's, and any repo whose renames changed. Saving: about 1 CPU s at 60 repos (`factsRecords` is 1.6 sampled s), only in the app's process.

**2. The estate join** (`joinFactsSteps`, `packages/core/src/facts-join.ts:1142`). Each call of each repo is joined by what it reads: the hosts its settings and placeholders resolve to and the repos that answer on them (the manifests, the answers, a person's pairings); the entries of those repos that serve its method and path (`routeScore`); with no host, or none that answers, every entry of the estate that serves the path (the fallback, where an ambiguity counts every entry that serves it: `sameSegments`, a segment `{}` matching any); each gateway's routes on its host; for a publish, every listener of its topic. A change of repo R reaches: every call of R; every call whose host resolves (before or after) to R; every call whose path, by its segments, matches an entry R serves before or after; every call through a gateway whose routes R changes; every publish of a topic R listens to before or after, and every listener of a topic R publishes. Patch: an index from what is read (a host, a path's segment count and its literal segments, a gateway's host, a topic) to the calls that read it, from the last join; the calls it names for R's old and new facts are joined again, the rest keep their result, and the results are put together in the order the full join gives them (by repo, then by call, as it walks them now). The joins applied (0.9 s) are per arrow, recomputed for the arrows of the calls joined again. Saving: at 60 repos of the big estate 3% of the arrows (412 of 12,322) have the changed repo at an end or cite it, and 5% (617) are on a method and path it serves, so about one call in twelve is joined again; at most about 3.5 of its 4.4 CPU s.

**3a. The merge** (`mergeCatalog`, `packages/core/src/merge.ts:238`). Records are collected by key (an endpoint by component, method and path, everything else by kind and id), and each key's records combined in input order (`combine`); before that, a store name two components claim becomes two stores (step 0), and after, a loose end is resolved against every endpoint by host and path. A change of R reaches: every key with a record of R before or after; a store name R's records claim or stop claiming; every loose end whose host or path matches a record of R before or after. Patch: keep each key's combined record and its members' order; recompute the keys R touches and the loose ends the index (as for the join) names. Saving: most of 2.1 CPU s; at 60 repos of the big estate 1.8% of the records cite the changed repo (1,855 of 100,382) and 12% cite more than one repo.

**3b. The features and their flows** (`detectFeaturesWithReport`, `packages/features/src/detect.ts:761`). A flow is traced from each entry point, breadth first, through the calls and events out of each component it visits that share a word with it, and the tables there that share one (`Tracer.traceIx`); the entry points a flow reaches join its feature, and flows of the same primary resource are one feature. A trace reads only, for each component it visits: its calls and events out and their words, its tables and their words, the starts there (its entry points and the calls into it, for the tables they claim), whether it is the estate's own, and its system's word. So a trace can be kept by the hash of those views of the components it visited (and of its entry point's own record), and traced again only when one of them changed. Then the groups (a union-find of the reached entry points, cheap) and each feature's records and evidence are made again from the traces, as now.

The catch is the estate: the prototype found every trace visiting the changed repo, on the big estate (7,723 of 7,723 at 60 repos) and on the field-shaped one too (962 of 962), where the gateways route the flows through every service. In the big estate every flow visits every service, so every trace visits the changed repo, and keeping traces saves nothing there; on the field-shaped estate it saves most of a pass that costs 0.3 s. Two patches that do reach the big estate, each provable on its own:

- **The same start, traced once.** A trace is a function of its entry point's component, words and mode (and the graph, fixed in a build); entry points with the same three share one trace. At 60 repos of the big estate 7,723 entry points have 6,003 distinct starts: the breadth-first part traced once per start, each entry point's own head (its id, and the calls into it and who makes them) added to it, saves about 21% of the traces' time (18% on the field-shaped estate)..
- **A trace resumed where the change first reaches it.** Until a trace takes the changed repo's component off its queue, it reads only components whose views didn't change, so its state there (what it holds, its queue, what it queued) is the last build's; kept from the last build, the trace goes on from there. The traces first reach the changed repo about half-way through their visits (49% at 60 repos of the big estate), so resuming saves about 40% more of the traces' time there (51% on the field-shaped estate).. It costs the memory of every trace's state at that point (the flows of 60 repos hold some 50 million record numbers), which this design would have to measure against the owner's 1 GB first.
- Worker threads for the traces (a trace reads the graph only) were measured as no gain on these 2 CPUs; on 8 cores they might take 4 of the 9.3 s.

**3c. The glossary** (`buildGlossary` and `codeTermsOf`, `packages/glossary/src/build.ts:158`, `code.ts:157`). Each record's names give words; a word is a term when two records use it or a table is named by it, and a compound name is a term of its own; each term's record (its uses, its fields, its types, its conflicts, its first use in each repo) reads the names that use the word, the wiki pages and the curated decisions. A change of R reaches the terms whose key is a word of R's names before or after, and the terms whose count crosses two. Patch: keep, per term, its record and the names it was made from; recompute the terms whose words R's names use before or after; then the columns' `glossaryTerm` for those terms. Saving: at 60 repos of the field-shaped estate 260 of its 6,021 code terms use a word of the changed repo's names (4%), so most of its 0.4 CPU s; on the big estate 23 of 24 (every entry there has the same field names), so nothing..

**4 to 7.** Link evidence, the legacy overlay, the curated decisions and each repo's flows and loose calls cost 0.3 s together at 60 repos: not worth a patch.

**8. The record texts and build.json** (3.6 s). Each record's JSON is made and hashed to find its kept text. A record a patched pass kept as the last build's own object (frozen, as the catalog's parses are in step 4) has the last build's JSON hash, so its text is known without making its JSON again; only the records a pass made again are serialized. Saving: most of the 3.6 s, but only for the records the passes above keep, which in the big estate the features (every Capability) and the glossary are not.

### How each patch is proven

The rule of this note holds: every committed file byte for byte what a full build writes, or the patch is held back.

- **An equivalence oracle in the normal suite, on both estates.** The patched build computes both ways after every write (as step 1's comparison does today): the full pass and the patched one, and requires the same records in the same order, the same problems and the same notes. It runs on the big and the field-shaped estates through a sequence of one-repo changes chosen to reach each dependency above: a call's host moved to another repo, an entry added on a path another repo's call falls back to, a gateway route changed, a topic published and listened to, a word that crosses the two-record count, a store name claimed by a second component, a flow that newly reaches an entry point.
- **The reads checked, not trusted.** In the tests each patched pass runs over a recording view of its inputs: every host, path, route, topic, component view and name it reads is noted, per call, per trace and per term; a test fails when a result the patch kept read anything the change touched. This is what makes the dependency lists above checked by the code rather than by this note.
- **Property tests.** The CS4 harness gains the patched build as its system's build, with the master oracle unchanged (the catalog is the bytes of a fresh build of the final slots with no cache), and a fast-check property per pass: for random small estates and random one-repo changes, the patched pass equals the full pass.
- **A step whose proof fails is held back,** and the measured time of the Apply without it is what the release notes give. The owner is told what failed.

### What it can reach

On the prototype (below) and the phase table, at 60 repos of the big estate: the projection about 1 s, the join and the joins applied up to about 3 s, the merge up to about 1.5 s, the glossary nothing (23 of its 24 terms are reached), the record texts about 1 to 2 s for the records the passes keep; the features only through the dedupe and the resume (about 2 of the 9.3 CPU s for the dedupe, about 3.7 more for the resume). In all, about 9 to 13 CPU s of the app's 44 (9 without the resume), which leaves about 31 to 35 CPU s, two to three times 15 s on these 2 CPUs: **15 s on the big estate at 60 repos is still not reachable with patches that can be proven**, unless the features are traced another way (fewer traces, or each cheaper), which is a project of its own with the features' oracle tests as its proof. On the field-shaped estate the passes are already a small part (the features 0.3 s, the glossary 0.4 s at 60 repos) and the Apply is under 15 s.

Recommended order, if the owner approves: the projection per repo (1), the dedupe of traces (3b), then the join (2) and the merge (3a) with the recording view, each with its oracle first; the glossary (3c) and the resume (3b) only if those leave the big estate within reach.

### The prototype

A measurement, not code to ship (a test file run once, not committed): the big estate and the field-shaped one built in memory, then, for a change of `forge-svc-01`, what each pass's dependencies reach.

| What a change of forge-svc-01 reaches               | big, 60 repos (100,407 records)               | field-shaped, 60 repos (17,179) |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------- |
| traces that visit it (the features)                 | 7,723 of 7,723                                | 962 of 962                      |
| where they first reach it, on average               | 49% of their visits                           | 54%                             |
| distinct starts (component, words, mode)            | 6,003 of 7,723: 21% of the traces' time saved | 803 of 962: 18%                 |
| resuming at the first visit, more                   | about 40% of the traces' time                 | about 51%                       |
| code terms using a word of its names (the glossary) | 23 of 24                                      | 260 of 6,021 (4%)               |
| arrows to, from or citing it (the join)             | 412 of 12,322 (3%)                            | 78 of 1,717 (5%)                |
| arrows on a method and path it serves               | 617 (5%)                                      | 104 (6%)                        |
| records citing it (the merge)                       | 1,855 (1.8%); 12% cite more than one repo     | 314 (2.8%); 14%                 |

The traces' times are the prototype's (`traceIx` keeping its visits, 6.3 s at 60 repos of the big estate here against the pass's 9.3 CPU s in a build at a higher load); the shares are what the estimates above use.
