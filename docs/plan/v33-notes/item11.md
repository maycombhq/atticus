# v33 notes: item 11, the two slow steps of an Apply

What the shared files should say for the `b33/item11-speed` branch. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## What was measured

`packages/cli/test/apply-speed.test.ts` generates the estate at test time in a temporary folder (`makeBigEstate` of `big-estate.ts` with small repos: 45 services and 15 gateway proxies, 60 repos, 13,508 record files; the owner's 41 repos had 12,846) and writes an `inputs/` folder of 30 partner OpenAPI specs (120 operations each, 24 titled by a Forge service, 6 by nobody) and 30 draw.io diagrams (200 boxes each, most naming a service). After a cold build it runs two Applies of one changed repo (`writeFactsIntoCatalog`, as `verify <repo> --write` and the app's Apply do) and prints every phase on `buildPhases`' clock with the files the guards' hash opened. Its numbers on this build machine (2 shared CPUs, Linux, load 2 to 6), each the first Apply after the cold build and then a steady one:

| Step                                                        | Before (main 7edc41d8) | After                      |
| ----------------------------------------------------------- | ---------------------- | -------------------------- |
| The guards' hash (`hash:` and `guards: build.json read`)    | 0.25 to 0.30 s         | 0.20 to 0.29 s (unchanged) |
| Files the hash opened, first Apply after the build / steady | 13,508 / 13            | 13,508 / 13 (unchanged)    |
| The intake (`build: 3 intake, and the merge again`), steady | 2.34 to 2.58 s         | 0.60 to 0.74 s             |
| of which names and readers                                  | 1.28 to 1.44 s         | 0.44 to 0.50 s             |
| of which read, hash and classify; defences                  | 0.21 to 0.25; 0.37 s   | 0.01; 0.00 s               |
| of which partner specs (conflicts with code)                | 0.30 to 0.32 s         | 0.02 s                     |
| The whole steady Apply                                      | 6.2 to 6.6 s           | 3.8 to 4.4 s               |

The guards' hash was not slow here: hash-cache.ts (beta.28.5) keeps each record file's hash by its size, time, change time and identity, so a steady Apply opens only the files the last one wrote (13 of 13,508). It opens every file only when the kept hashes are missing: the first Apply after a build that wrote every file (a cold build, an upgrade), whose new files are inside the racy window when it ends. Where the owner's 21.9 s comes from is not found on this machine; see Open.

## What changed

- **The intake's lookups read the catalog once.** `resolveNames` read every record for each name (a diagram's box, a spec's title): `nameResolver(records, systems)` in `packages/reconcile/src/aliases.ts` builds the ids, components and aliases once and remembers each name's answer; `resolveNames` is it over a list, unchanged. The partner specs' check against the code looked up each operation, and each spec's calls, by reading every record: the code endpoints and the sync calls are now put in two maps once (`scan-inputs.ts`), in the records' order, so the triage is the same.
- **A file taken in again isn't classified or screened again.** What a file's bytes alone decide (its class, ADR 0042's screening) is kept by its path and sha-256 from the last intake in the same process (the app's server, a `verify --all --write`), and only the last intake's files are kept. A file whose bytes change has another hash, so it is classified and screened as new.
- Nothing else: no contract, no copy, no surface. Non-test source +41 lines.

## CHANGELOG.md (beta.33, Fixed)

- **The intake of each Apply, about 3 times faster.** It looked up each diagram box, spec title and spec operation by reading every record of the catalog: 2.3 to 2.6 s of each Apply on a generated estate of 60 repos and 13,500 records with 60 documents in inputs/, now 0.6 to 0.7 s. The catalog is read once an intake, and a file taken in again by the same process (the app, `verify --all --write`) isn't classified or screened again unless its bytes changed. What the intake makes is unchanged.
- The guards' hash, measured on the same estate: a steady Apply opens only the record files the last one wrote (13 of 13,508, 0.2 s). A test now checks that on every platform CI runs.

## docs/build-status.md

The two slow steps of an Apply (2026-11-25; item 11 of `docs/plan/ai-first.md`; no ADR, no contract change). **Works:** the intake's name, spec and call lookups read the catalog once (`nameResolver`; the code endpoints and sync calls by key); each input file's class and screening kept by path and hash in the process; the speed test on a generated 60-repo estate with inputs/ (guards' hash and intake under 3 s of a steady Apply; a steady Apply opens under 1% of the record files), with a same-size hand edit whose time was put back still refused and a file changed to CRLF only not taken for an edit. Tests: `cli/test/apply-speed.test.ts`, `intake/test/defences.test.ts` (a file screened again once its bytes change). **Open:** see the notes.

## docs/codebase-map.md

| What                                     | Where                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Names resolved with the catalog once     | `packages/reconcile/src/aliases.ts` (`nameResolver`, `resolveNames` over it), used by `intake/src/scan-inputs.ts`                             |
| An input file's class and screening kept | `packages/intake/src/scan-inputs.ts` (`byBytes`, by path and sha-256, the last intake's files only)                                           |
| The speed test of an Apply (item 11)     | `packages/cli/test/apply-speed.test.ts` (estate: `big-estate.ts` with small repos and an inputs/ it writes; `ATTICUS_APPLY_REPOS` for a size) |

## Open, for the next step

- **The owner's 21.9 s hash is not reproduced.** On Linux the kept hashes hold; the full read happens only when they are missing. If Windows CI's run of `apply-speed` passes the count check, the kept hashes hold there too, and the owner's number is a full read each time on that machine: `atticus selfcheck --timing --names` says how many files the hash read again. Suspects to check there: a metarepo in a synced folder (OneDrive moves a file's change time when it changes its attributes), and the cache file not written (`writeFileAtomic` with `quick` gives up while antivirus holds it).
- **The first Apply after a full build opens every file** (13,508 here, 0.3 s; seconds under antivirus). Keeping the hashes the build wrote would need a rule for files inside the racy window; not done, as a missed hand edit is worse than a slow first Apply.
- **The budget is loose on the intake.** At three times the new figure (3 s) the old intake (2.3 to 2.9 s with the hash) passes it on this machine; the count of files opened is the sharp check for the hash, the phase figures in the test's output for the intake. Raising the inputs (more diagrams and operations) widens the gap: the old lookups grow with names times records.
- What is left in the intake is reading the specs and diagrams (0.44 s, each spec parsed twice: `readOpenApiSpec` and `readVendorSpec`; each diagram twice: `readDrawio` and the draw.io ingestor) and the second merge (about 0.15 s).
- `apply-speed.test.ts` is in `pnpm test` (about 50 s here, most of it the cold build).
- **Size budget.** `scripts/check-size-budget.mjs` is over before this change (+1,224 over the budget on this branch's base, +1,265 with it); this change adds 41 non-test lines.
