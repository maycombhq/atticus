# 0197. build.json lists each source once

- Status: accepted (2026-11-15, by the product owner, as proposed: content-hash set ids, no `atticus upgrade` step, and the "newer Atticus" refusal in a separate 2.0.0-beta.28.1.1). Amended the same day: the owner dropped the separate 2.0.0-beta.28.1.1. The newer-Atticus refusal ships inside beta.28.2, from the branch `fix/b2811-newer` (see "Migration and older versions").
- Date: 2026-11-15 (proposed and accepted)
- Release: 2.0.0-beta.28.2 (speed only)
- Amends: ADR 0195 ("`build.json`'s sources", point 7's undo copies, and point 9's addendum of 2026-11-13, which proposed this)
- Contracts: none of C1 to C6, and the facts file is unchanged. `catalog/sources/build.json` is one of the formats ADR 0195 versions outside the contracts; its `version` goes from 1 to 2. The JSON Schema `atticus schema export` writes for it (`slotJsonSchemas`) changes with it. No local API route reads or returns it. The newer-Atticus refusal adds one refusal reason, `newer-atticus`, to C4 (Local API 3.15.0, additive); it ships from `fix/b2811-newer`, not from this ADR's code.

## Context

`build.json` (`BuildManifest` in `packages/scanner/src/slots.ts`) lists every file the last build wrote under `catalog/generated/`, with its SHA-256 and the sources it came from: the slots of the repos its evidence names, `catalog/sources`, and each build input (ADR 0195, "`build.json`'s sources"). The guards use it to tell a hand edit from a build's file, and to explain each removal by a source whose hash changed. It is committed with the catalog.

Every file lists its sources in full, so almost all of `build.json` is repetition. These numbers come from the benchmark estate of 2026-11-13 (`packages/cli/test/big-estate.ts`, 60 repos and 30 gateway proxies, 100,407 records). They were not measured again for this note.

| `build.json` at 60 repos and 30 proxies | Now                                             |
| --------------------------------------- | ----------------------------------------------- |
| size                                    | 190 MB (182 MB with no proxies, 96,725 records) |
| files listed                            | 100,404                                         |
| source entries                          | 1,138,772 (11.3 a file)                         |
| distinct sources                        | 189                                             |
| distinct sets of sources                | 3,291                                           |

Each `verify <repo> --write` (54 to 59 CPU s on that estate) handles the file several times. The times below are per write, measured on a shared 2-CPU machine at load 6 to 10:

- **The guards' read** parses the committed file, 1.6 to 6.2 s.
- **The build's "files and build.json" phase** makes the manifest and serializes it, 2.8 to 9.5 s. That phase includes the records' own files; the manifest's share was not measured separately.
- **"Keep build"** writes the build cache, about 150 MB on disk, which holds the manifest's text: 2.5 to 7.9 s.
- **Two copies go into each undo copy:** the `build.json` before and `next-build.json`. Since beta.28.1 both are made by the system rather than written from JavaScript. With five undo copies kept, that is about 1.9 GB on disk.
- **The 1.14 million source objects** stay on a heap of about 3 GB while the guards run.

## Decision

### 1. One table of sources, sets of them by content, a set per file

`build.json` version 2 has this shape:

```json
{
  "version": 2,
  "buildVersion": "…",
  "sources": { "<path>": "<sha256>", "…": "…" },
  "sourceSets": { "<set id>": ["<path>", "…"], "…": ["…"] },
  "files": [{ "path": "<path>", "sha256": "<sha256>", "sources": "<set id>" }]
}
```

- **`sources`** maps each source's path to its hash. A build reads each source once, so each path has exactly one hash.
- **`sourceSets`** maps a set id to the sorted paths of its sources.
- **A set's id** is the first 16 hex characters of the SHA-256 of its paths, each followed by a newline. If two sets ever share an id, the writer lengthens only those sets' ids, 4 hex characters at a time, until none are shared. Every other id keeps its 16 characters, so a collision changes no lines but those of the sets in it. This rule is deterministic: an id depends only on its set and on which other sets share its start, so the same build always gives the same file. (Amended after the review of 2026-11-15. As first built, a collision lengthened every id.)
- **Each file** names its set by id.
- **Order:** `sources` is sorted by path, `sourceSets` by id, and `files` by path, all with `cmpText`, as version 1 is. The same build gives the same bytes on every platform, with LF line endings and hashes over LF-normalised text, as ADR 0195 already requires.

Two choices of shape are deliberate:

- **Sources are keyed by path and sets by their content, not by numbers.** That keeps the committed diff small. A source whose hash changes is one line in `sources`; today the same change rewrites every file entry that lists it, up to 100,000 of them. A repo added to the estate adds sources and sets without renumbering any. The exception is a new kind of input that enters every set, a `catalog/sources/federated/<id>` that every record rests on, say. It changes every set's paths, so it rewrites every set id and every file entry once, as such a change rewrote every file's list in version 1. With numeric indices, as first proposed, adding one source would shift the index of every source after it in sort order, and so rewrite every set that names one of them and possibly every file.
- **`build.json` keeps the expanded meaning.** A file's sources are its set's paths, each with its hash in `sources`. Every guard, the removal reasons, the undo checks and the merge-time check (ADR 0195 point 2) mean what they mean today.

Estimated size: about 17 MB at 100,404 files. The file entries are about 16.5 MB, the sets about 1.5 MB, and the sources table under 30 KB.

### 2. In memory too

`BuildManifestT` takes the same shape in memory: files hold their set's id, and sets are built once per build. The guard's removal pass already looks at each distinct source once (`sawNow` and `sawThen` in `guardBuild`); it now does so by set instead of by file.

### 3. What stays as it is

- **Every record file is still read and hashed.** The hand-edit guard compares every file's hash, and no hash is trusted by a file's size and time (the owner's decision of 2026-11-13).
- **The file stays one committed JSON file**, in the same place, built only by the build. A merge conflict in it is still resolved by building again.
- **Every source is still listed**, empty inputs included, as ADR 0195 asks.

## Migration and older versions

- **Reading both formats.** From beta.28.2 the reader accepts version 1 and version 2, and the writer writes only version 2. Version 1 is turned into version 2 in memory when read: its sources are grouped and its sets found. Converting the 190 MB file once took the same time as reading it does today. Version 1 stays readable for as long as a version 1 `build.json` can turn up:
  - in the five undo copies;
  - in an older commit or branch of the metarepo;
  - on the other side of a merge, which the merge-time check reads from git.
- **No `atticus upgrade` step.** The first build of beta.28.2 writes version 2. It is not a removal, because `buildVersion` changes with it, and it takes an undo copy as any write does.
- **Undo across the change.** `atticus catalog undo` across the change puts back the version 1 `build.json` byte for byte from its copy, and checks the restored files against it as a version 1 manifest. The next build writes version 2 again.
- **A newer version than the reader knows** (3 or later, for beta.28.2) is refused. This is the guard's refusal with reason `newer-atticus`, a refusal reason added to C4 (Local API 3.15.0; the change is additive). Its words are: "This metarepo's catalog was built by a newer Atticus (build.json version N; this Atticus reads up to M): upgrade Atticus (npm i -g @maycombhq/atticus@beta), don't run `atticus upgrade`." `guardBuild` makes this check before it calls `parseBuildManifest`. M is `BUILD_MANIFEST_READS` in `packages/scanner/src/slots.ts`, which equals `BUILD_MANIFEST_VERSION`, so it is 2 in beta.28.2. Nothing is written, and `--discard-edits` doesn't apply to it. `parseBuildManifest` keeps its own `newer` result and the thrown `NewerBuildManifestError` as a last resort only, for a reader that the guard's check doesn't come before. People see the refusal, not that error.
- **beta.28.1 and older reading version 2.** These read it as unreadable. Their guard then takes the catalog for one from before beta.27 and refuses every build with "run atticus upgrade". Their `atticus upgrade` sees a `build.json` and does nothing. Nothing is lost, but the advice is wrong, and `--discard-edits <n>` there would write the whole catalog again as version 1. A 2.0.0-beta.28.1.1 with only the "newer Atticus" refusal was proposed. The owner dropped it, so the refusal ships in beta.28.2 and later only. The beta.28.2 release notes therefore have to tell a team to upgrade every member together before the first build of beta.28.2 is committed.

## Expected gains

These are estimated from the measurements above and have not been measured yet. They are per `verify <repo> --write` at 60 repos and 30 proxies:

| Step                                          | Now                  | Expected                                     |
| --------------------------------------------- | -------------------- | -------------------------------------------- |
| the guards' read of `build.json`              | 1.6 to 6.2 s         | 0.1 to 0.5 s                                 |
| making and serializing the manifest           | part of 2.8 to 9.5 s | under 1 s                                    |
| keep build (the manifest's text in the cache) | 2.5 to 7.9 s         | 1 to 4 s (the records' texts stay)           |
| the two undo copies of `build.json`           | 2 × 190 MB           | 2 × 17 MB; about 170 MB for five undo copies |
| source objects on the heap                    | 1.14 million         | 3,291 sets                                   |

That is about 8 to 15 s off a write, taking it from 54 to 59 CPU s to an estimated 40 to 50 CPU s, or 60 to 90 s on the clock at that load. It does not reach the 15 s goal. What remains after this step:

- **The passes over the whole estate, about 25 s:**
  - features 8 to 21 s;
  - the estate join 4.5 to 6.7 s;
  - the glossary 3.6 to 6 s;
  - the merge 3 to 4 s.
- **Hashing every record file, 10 to 13 s.** This stays, because nothing is trusted by stat.
- **Reading the slots and the kept parses, 3 to 5 s.**

Step 2 of beta.28.2 would make the features and the glossary incremental: only the clusters and terms that a changed repo's records reach are worked out again. A write would then be roughly 25 to 30 CPU s. The 15 s goal at 60 repos would also need either the record files hashed faster than this machine's disk does it (unmeasured on a developer's SSD) or the stat-trusted hashes the owner declined.

## Risks and tests

- **Round trip, old to new.**
  - Every version 1 `build.json` the tests make (the Forge goldens, the CS4 property tests' worlds, the 60-repo bench) converts to version 2 and back to version 1 byte for byte.
  - A build writes the version 2 that converting its version 1 gives.
  - The goldens in `packages/cli/test/golden/big-estate.json` change only in the `build.json` digest; the record digests stay.
- **The guards mean the same.** Every guard and removal reason gives the same result from either version. This covers hand edits, removals and their `explainedBy` and `reasons`, an interrupted build's `next-build.json`, both sides of a merge, and undo. Tested by running the guard tests on both versions, and by adding a `build-json-v1` world to the property tests that starts from a version 1 file.
- **Determinism.**
  - The same build gives the same bytes, checked in `big-estate-equivalence.test.ts`.
  - A test forces a set id collision and checks the lengthened ids.
  - Windows CI runs the round trip and the goldens; LF line endings and `cmpText` order are already checked there.
- **Older versions.**
  - With the newer-Atticus refusal of `fix/b2811-newer`, a test reads a `build.json` of a later version and refuses with `newer-atticus` and its words. Without it, beta.28.1 and older can't be tested to refuse, and the release notes cover them (see above).
  - A beta.28.2 test reads version 3 and refuses the same way.
- **Speed.** `big-estate-speed.test.ts` gains a budget for the guards' read of `build.json`. The bench reports the size of `build.json` next to each write.

## Alternatives considered

- **gzip the file.** At this level of repetition it would shrink to a few MB, but it still has to be compressed, parsed and held in memory at full size on every write, so parse time and heap stay where they are. It also ends the readable diffs and merges of a committed file.
- **NDJSON, one file per line.** Lines could be streamed, but the same 1.14 million source entries are still parsed. It also gives up the strict JSON Schema of a single document.
- **One `build.json` per repo.** Many records name several repos (every arrow, every glossary term), so a file's sources don't divide by repo. The guards would also have to read every part anyway, to see a hand edit anywhere.
- **A SQLite index.** It isn't text, so it can't be committed and reviewed. It adds a native dependency on every platform. It would replace a format the merge-time check reads from git.
- **Numeric indices for sources and sets**, as first proposed. They are smaller by about 1 MB, but a new source renumbers what follows it (see Decision §1).

## As built (2.0.0-beta.28.2, 2026-11-15)

**Code.** `packages/scanner/src/slots.ts`: `BuildManifest` is version 2. `BuildManifestV1` stays for reading. The module also has `manifestOfFiles` (the writer's shape), `sourceSetIds` (16 hex digits; only the ids that collide are lengthened, by 4 at a time), `sourcesOf` (a file's sources, kept per set), `manifestFromV1` and `manifestToV1`, `serializeBuildManifestV1`, and `NewerBuildManifestError`. `parseBuildManifest` reads either version as version 2. It refuses a later one with `newer`, and a set or source a file names that isn't listed. A version 1 that lists one source at two hashes is refused with "build.json was edited or merged by hand: build again", because no build writes that. In the guard, a `build.json` that is there but doesn't read, with no undo copy whose manifest names every file (another clone of the metarepo, say), is refused as `hand-edits` (an existing C4 reason) with that problem, and `--discard-edits <every record file>` builds again. It is not refused as `not-upgraded`, whose advice, `atticus upgrade`, does nothing for it. The refusal carries `unreadableManifest: true`, added to the C4 refusal view in Local API 3.15.0 (additive). With it, `refusalCommands`, the CLI's hint and the app's refusal offer only the build again with `--discard-edits <every record file>`, never `atticus catalog edits --curate`. `slotJsonSchemas` versions each `$id`. `BuildManifest` is `…/sources/v2/BuildManifest.json`, and `BuildManifestV1`, which is still read, is exported as `…/sources/v1/BuildManifestV1.json`.

`build.ts` builds the manifest with `manifestOfFiles`, and its guards walk each set's sources once. A later version is refused before anything is read or written: `guardBuild` (and every writer, before it writes) checks each versioned file's version first and refuses with the `newer-atticus` reason (Local API 3.15.0) and its words, "This metarepo's catalog was built by a newer Atticus (build.json version N; this Atticus reads up to 2): upgrade Atticus (npm i -g @maycombhq/atticus@beta), don't run `atticus upgrade`." `BUILD_MANIFEST_READS` is `BUILD_MANIFEST_VERSION`, 2. `NewerBuildManifestError` stays only as a last resort, for a reader the check doesn't cover. The version 3 tests in `big-estate-equivalence.test.ts` (`buildAndWrite` and the CLI) expect the refusal and its words.

`BUILD_VERSION` is not bumped. The first build of version 2 changes no record and is not refused: the property tests' beta.28.1 world, the equivalence tests and the 60-repo bench all write over a version 1 file.

**Tests.**

- `packages/scanner/test/slots.test.ts`: the Forge golden as beta.28.1 wrote it (`fixtures/forge/build-json/build.v1.json`) reads as the version 2 golden (`fixtures/forge/slots/build.json`, which the build writes, `build.test.ts`). Version 2 gives version 1 back byte for byte. The test also covers CRLF, any order giving the same bytes, a forced set-id collision, and the refusals.
- `packages/cli/test/build-json-v1.ts` (`asBeta281`) writes a metarepo's `build.json` and its undo copies as beta.28.1 wrote them. The property tests get it as a third prefix, with two examples: a write over version 1, undone, puts version 1 back byte for byte; and writes over version 1 equal a fresh build.
- `big-estate-equivalence.test.ts` checks:
  - the same guard result over either version, with a hand edit and removals pending;
  - a build cut short whose undo copy holds version 1 is caught up;
  - version 3 is refused by `buildAndWrite` and by the CLI, and nothing is written.
- `big-estate-speed.test.ts` checks that `build.json` is under 300 bytes a file (measured 218 at 12 repos; version 1 is about 1,900) and that the guards read it in under 0.5 s (measured 0.04 s).
- `big-estate-golden.test.ts` pins the digest of `build.json` and of the version 1 it gives back. Only the `build.json` digest in `packages/cli/test/golden/big-estate.json` was recorded again, on purpose. Every record kind's digest is unchanged, and the version 1 digest is the one beta.28.1 recorded (`f7faea44…`).
- `v1Of` in `build-json-v1.ts` checks that each version 2 it turns into version 1 reads back as the same version 2, byte for byte. Every property-test world that `as-beta-28-1` rewrites, and the bench, go through it.
- The bench checks the round trip on its estate.

**Measured.** The release's numbers come from invented Forge estates, with `packages/cli/test/big-estate-bench.test.ts` on one machine, beta.28.1 against beta.28.2:

- At 60 repos (about 104,000 records), one repo's Apply takes 49 s, 65 s before, with 29% less CPU time. At 30 repos (about 52,000 records) it takes 20.1 s, 26.4 s before.
- The pairing preview at 60 repos takes 10.1 s, 23.8 s before. The Connect panel's cold read takes 4.1 s, 7.6 s before.
- `build.json` at 60 repos is 24.8 MB, 198.5 MB before.
- The first write over a version 1 catalog, which writes version 2, takes about 86 s at 60 repos.
- A cold build is not reliably faster. The 15 s goal for one repo's Apply at 60 repos is still open.

**Earlier measurement (30 repos only).** These numbers come from the bench estate at 30 repos and 15 gateway proxies (`ATTICUS_BENCH_REPOS=30 ATTICUS_BENCH_GATEWAYS=15`, 50,291 records), on a 2-CPU machine shared by four builders at load 4 to 14. That run did not reach 60 repos: with about 3 GB free, the first try at 30 repos was killed for memory. The 60-repo figures above were measured later. The base is beta.28.1's code (`origin/perf/b282` at 941b2049). It built the estate cold and then made six writes, in three runs. This code then ran on a copy of that estate. Its first write read version 1 and wrote version 2, and five steady writes followed in three runs, alternating with the base's. Each cell gives the range over the steady writes. A phase under 0.05 s isn't printed, so it shows as "< 0.05".

| One repo's `verify <repo> --write`, 30 repos              | Version 1 (base)      | Version 2             |
| --------------------------------------------------------- | --------------------- | --------------------- |
| `build.json`                                              | 95.2 MB               | 11.2 MB               |
| parsing it (the bench, alone)                             | 0.87 to 2.20 s        | 0.09 to 0.22 s        |
| serializing it (the bench, alone)                         | 0.39 to 0.74 s        | 0.03 to 0.06 s        |
| the guards' read of `build.json`                          | 0.49 to 1.02 s        | < 0.05 to 0.11 s      |
| the guards in all                                         | 2.7 to 6.5 s          | 0.8 to 2.9 s          |
| keep build                                                | 1.3 to 3.7 s          | 1.0 to 2.8 s          |
| write catalog (with `build.json` and its two undo copies) | 1.3 to 3.3 s          | 0.3 to 0.9 s          |
| the two system copies of `build.json` alone (`cp`)        | 0.05 to 0.11 s        | 0.01 to 0.06 s        |
| an undo copy's two `build.json`s on disk                  | 2 × 95 MB             | 2 × 11 MB             |
| the build's "files and build.json"                        | 1.3 to 2.4 s          | 2.0 to 4.7 s          |
| hashing every record file                                 | 2.6 to 5.4 s          | 3.0 to 5.4 s          |
| the write, on the clock (median)                          | 32 to 38 s (36)       | 31 to 39 s (36)       |
| the write, in CPU time (median)                           | 22.4 to 26.3 s (24.6) | 20.7 to 22.6 s (21.3) |

The steps that handle `build.json` (the guards' read, the guards' walk of the sources, keep build and the write with its undo copies) take about 3 to 6 s less a write. CPU time is about 3 s less a write, and the ranges don't overlap. Wall-clock time didn't move within this machine's noise: the other builders' load moved the hash and the passes by several seconds between runs. "Files and build.json" didn't get faster here. Making the manifest is now a small part of a phase that also writes the record files' texts.

The first write of version 2 reads version 1 and writes version 2, with a build cache of the old format, so it builds without the cache. It took 47.4 s (43.8 CPU s), once. It was not refused: its 33 removals were explained, as the base's were for the same change. The undo copy it took holds the version 1 `build.json` byte for byte (`cmp`).

At 30 repos, version 2 is 223 bytes a file. Most of that is the file's path, which is why the 17 MB estimated for 60 repos is low. By the same ratio, 60 repos would be about 22 MB; measured later, it is 24.8 MB.

The ≤15 s goal stays open, as "Expected gains" says. A write's time now goes mostly to the passes over the whole estate, hashing every record file (3 to 5 s here), reading the slots and the kept parses, and the map. Step 2 of beta.28.2 (incremental features and glossary) is next.
