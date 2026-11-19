# 0205. One repo's Apply in fifteen seconds: what was measured, and what is reachable

- Status: proposed (for the owner's approval; nothing is built)
- Date: 2026-11-19
- Release: 2.0.0-beta.30, slice 10 ([the plan](../plan/v30.md))
- Builds on: ADR 0195 (point 9 and its addenda of 2026-11-12, 2026-11-13 and 2026-11-15), ADR 0197
- Contracts: none. C1 to C6 and the facts file are unchanged, and so is every committed file (`catalog/generated`, `catalog/sources`, `build.json`). Only local, git-ignored caches change: the build cache (`.index/build-cache/`, `BUILD_CACHE_FORMAT` goes from 2 to 3) and the parse cache. No migration: an old cache is no cache.

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
| hash every record file (2 worker threads)                           | 0.3       | 0.81     | 1.43     | ×1.8     |
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
- **The guards** read every record file and hash its bytes (the owner's decision of 2026-11-13: nothing is trusted by a file's size and time), 1.4 s, and compare with build.json, 1.8 s.
- **The index.** Apply doesn't build it: the index is opened when a map tool or `atticus ask` needs it (`openIndex`, `packages/index`). There is nothing to skip.

So the only reuse that can be proven inside the passes is pass 2's projection per repo, worth about 1 s at 60 repos and only in the app's process. What can be cut with a proof is around the passes: work that compares, parses and caches the whole catalog to find or keep the part that changed.

## Decision (proposed)

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
- **Trusting a record file's size and time** in the guard: declined by the owner on 2026-11-13, and not asked again.

## What is reachable in beta.30

| Estate                       | Now (the write; the command) | After steps 1 to 3 (a process of its own) | After step 4 (the app) |
| ---------------------------- | ---------------------------- | ----------------------------------------- | ---------------------- |
| field-shaped, 60 repos       | 5.3 CPU s; 8.3 CPU s         | about 4.4 CPU s; the command about 7.4    | about 4 CPU s          |
| big, 30 repos and 15 proxies | 19.9 CPU s; 22.6 CPU s       | about 16.6 CPU s                          | about 15.5 CPU s       |
| big, 60 repos and 30 proxies | 43.3 CPU s; 45.4 with verify | about 36 CPU s                            | about 33 CPU s         |

- **The field-shaped estate is under 15 s today** on this machine at a load of 10 for the write (10.6 to 12.4 s), and the command is at its edge (13.6 to 17.7 s, median 15.5 s, for 8.3 CPU s). On an idle machine both are about 5 to 8 s, and the steps take about 1 CPU s more off.
- **The big estate at 30 repos** reaches about 14 to 16 s on an idle 2-CPU machine after the steps (today 17.5 s at a load of 4), and 1.5 to 3 times that at this machine's usual load. Not a reliable 15 s.
- **The big estate at 60 repos does not reach 15 s in beta.30.** After the steps, about 33 to 36 CPU s, about that on the clock on an idle 2-CPU machine. The passes over the whole estate (pass 2, the merge, the features, the glossary) take 17.3 s and pass 8 another 3.6 s, and the hash of every record file 1.4 s: 22 s with nothing else at all. Reaching 15 s there needs the features (9.3 s, growing with the square of the estate) and the other passes to be made incremental, which can't be proven equal, or a new way of tracing features, which is a project of its own with the features' oracle tests as its proof.

The release notes give the measured time whatever it is, as the plan says.

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
