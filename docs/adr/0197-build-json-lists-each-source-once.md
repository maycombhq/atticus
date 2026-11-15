# 0197. build.json lists each source once

- Status: accepted (2026-11-15, by the product owner, as proposed: content-hash set ids, no `atticus upgrade` step, and the "newer Atticus" refusal in a separate 2.0.0-beta.28.1.1)
- Date: 2026-11-15 (proposed and accepted)
- Release: 2.0.0-beta.28.2 (speed only)
- Amends: ADR 0195 ("`build.json`'s sources", point 7's undo copies, and point 9's addendum of 2026-11-13, which proposed this)
- Contracts: none of C1 to C6, and the facts file is unchanged. `catalog/sources/build.json` is one of the formats ADR 0195 versions outside the contracts; its `version` goes from 1 to 2. The JSON Schema `atticus schema export` writes for it (`slotJsonSchemas`) changes with it. No local API route reads or returns it.

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
- **A set's id** is the first 16 hex characters of the SHA-256 of its paths, each followed by a newline. If two sets ever share an id, the writer lengthens every id until none do. This rule is deterministic, so it never makes a different file from the same build.
- **Each file** names its set by id.
- **Order:** `sources` is sorted by path, `sourceSets` by id, and `files` by path, all with `cmpText`, as version 1 is. The same build gives the same bytes on every platform, with LF line endings and hashes over LF-normalised text, as ADR 0195 already requires.

Two choices of shape are deliberate:

- **Sources are keyed by path and sets by their content, not by numbers.** That keeps the committed diff small. A source whose hash changes is one line in `sources`; today the same change rewrites every file entry that lists it, up to 100,000 of them. A repo added to the estate adds sources and sets without renumbering any. With numeric indices, as first proposed, adding one source would shift the index of every source after it in sort order, and so rewrite every set that names one of them and possibly every file.
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
- **A newer version than the reader knows** (3 or later, for beta.28.2) is refused with: "catalog/sources/build.json was written by a newer Atticus (version N): upgrade Atticus to build here." Nothing is written, and `--discard-edits` doesn't apply to it.
- **beta.28.1 and older reading version 2.** These read it as unreadable. Their guard then takes the catalog for one from before beta.27 and refuses every build with "run atticus upgrade". Their `atticus upgrade` sees a `build.json` and does nothing. Nothing is lost, but the advice is wrong, and `--discard-edits <n>` there would write the whole catalog again as version 1. The proposal is a 2.0.0-beta.28.1.1 that only adds the "newer Atticus" refusal above, released before beta.28.2. A team on mixed versions then gets the right advice. This is an open decision for the owner: without it, the beta.28.2 release notes have to tell teams to upgrade together.

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
  - A beta.28.1.1 test reads a version 2 `build.json` and refuses with the new words.
  - A beta.28.2 test reads version 3 and refuses the same way.
- **Speed.** `big-estate-speed.test.ts` gains a budget for the guards' read of `build.json`. The bench reports the size of `build.json` next to each write.

## Alternatives considered

- **gzip the file.** At this level of repetition it would shrink to a few MB, but it still has to be compressed, parsed and held in memory at full size on every write, so parse time and heap stay where they are. It also ends the readable diffs and merges of a committed file.
- **NDJSON, one file per line.** Lines could be streamed, but the same 1.14 million source entries are still parsed. It also gives up the strict JSON Schema of a single document.
- **One `build.json` per repo.** Many records name several repos (every arrow, every glossary term), so a file's sources don't divide by repo. The guards would also have to read every part anyway, to see a hand edit anywhere.
- **A SQLite index.** It isn't text, so it can't be committed and reviewed. It adds a native dependency on every platform. It would replace a format the merge-time check reads from git.
- **Numeric indices for sources and sets**, as first proposed. They are smaller by about 1 MB, but a new source renumbers what follows it (see Decision §1).
