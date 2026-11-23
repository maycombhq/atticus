# v31: one build for many repos (notes for the shared files)

Row "One build for many repos" of [the v31 plan](../v31.md), gate 2. What `CHANGELOG.md`,
`docs/build-status.md` and `docs/codebase-map.md` should say once this is merged; those files are
shared, so they are not edited here.

## What changed

`atticus verify --all --write` (and the app's Apply to every repo, which runs it as a job) over
two repos or more now builds the catalog once:

1. Each repo is verified as before, in id order, with the same lines, the same refusals and the
   same facts left out. Its write is held instead of run (`writeFacts`, an option no flag sets).
2. After the last repo, every held repo's facts snapshot goes into one build, one set of guards
   and one write (`writeManyFactsIntoCatalog`), under one lock: one undo step for the whole run.
   The run's own lines come once, before any repo's: what the build's read noted, its warnings
   and removals (ADR 0195 point 4), and "Wrote the catalog for N repos in one build: … Each repo's
   specs, flows, questions, report and map below are of this one catalog, with every repo of the
   run in it. One undo step: atticus catalog undo takes the catalog write of the whole run back."
   with the whole run's records by kind (every record with `--verbose`). Undo takes back the
   catalog, `build.json` and the facts snapshots, not the contracts, specs, flows, questions,
   reports or maps.
3. Then, repo by repo, each repo's contracts, specs, flows, questions, report and map are written
   as its own write writes them, and the rest of its verify lines are said. Each repo's records
   line ("forge-svc-00's records: …", its `--verbose` list and its `changes` in `--json`) is the
   records of the run's write that cite that repo; `--json` gives the whole run's under
   `written.run` (its repos, its counts and its changes), the same in every repo's result.
4. An answer the run's questions opened again (ADR 0162, F8) is no answer for the next build: the
   run builds the catalog once more without it ("Built the catalog again without the answer
   opened again: …", one more undo step when a file changes).

So N repos cost one build instead of N. ADR 0207's "Builds: 38, one for each repo" becomes one
build, and a run of more than `UNDO_KEEP` (5) repos can be taken back with one undo.

- **One repo** (`--all` with one repo read, or the app's `only` list of one): exactly as before.
- **A refused one build** (a hand edit, removals past the count, a newer catalog, the lock held):
  nothing is written or said (not even the read's notes or the build's problems), and each held
  repo is written with its own build as before, so each refusal and note is said once, by its
  repo's own write, with its own next step.
- **A prototype in the run** is left out of the one build and written its own way after it (its
  facts kept, never in the catalog), as before.
- **A file another program holds during the one write** (or no room): nothing more is written,
  and every repo not written is said with its own command ("forge-svc-01: not applied: … Run it
  once that is put right: atticus verify forge-svc-01 --write"), as beta.28.5 does for one repo.
- **Stop** before the one write (while repos are verified, or while the one build is built or
  checked): nothing of any repo is written, and the run says "Stopped before the catalog was
  written: none of the N repos was applied. Not applied: …". Once the catalog is being written,
  Stop is too late for the run: the app says so in its own words for a write ("Stop came after
  the write had started: it finishes, so what it writes stays whole."), never "the run ends when
  this repo's write has finished". With the per-repo loop (rollback, or a refused one build),
  Stop is heard between repos as before.
- **A repo whose own files can't be written** after the one build (a file another program holds):
  that repo is said with its own command, as before; the others go on.
- **Progress**: "Repo N of M" and the time left at the rate so far are now mostly verifying, and
  say ", then one catalog build"; then "Writing the catalog once for N repos…" and the write's
  own steps.
- **Rollback**: `ATTICUS_APPLY_ONE_BUILD=0` in the environment restores the per-repo loop (each
  repo its own build), in the command and in the app's server.

## What is not byte for byte the same

**The catalog is.** The record files, `build.json` and the facts snapshots are the same bytes as
the same repos applied one after another. Tests: `apply-one-build.test.ts` (a), (c), (j). One
exception: when the run opens an answer again, the run's catalog is the one the next build makes
without that answer. The repos' own Applies keep the answer's records until the Apply after the
one that opened it, and keep them for good if the last repo opened it (`build.ts` reads the
answers before each build). Test: `apply-one-build-answers.test.ts`.

**Each repo's own files are the whole run's.** Every repo's specs, flows, questions, report
(`facts/<repo>.verify.yaml`) and map are worked out from the one catalog, which has every repo of
the run's new facts. A repo's own Apply works them out from the catalog of its turn, which has
only the repos before it. So where a later repo moves what an earlier one calls (forge-svc-01
moves the entry forge-svc-00's call c-4 joins), the earlier repo's map, report counts and questions
differ from the repos' own Applies. They are what the earlier repo's own Apply after the run would
say, which is the more current result. Where no repo moves what another calls, they are the same
bytes. Tests: `apply-one-build.test.ts` (a) and (a2).

**The links list in each report** is the run's, not one repo's write's. A repo's own write lists
the links its build made, unmade or changed against the catalog its write found. One build has no
write of one repo to tell a link by, so each repo's report lists the run's link changes with that
repo at either end, and a link changed with neither end in the run is in every report. No link a
sequence of Applies lists is missing (the tests check this). A link may be listed in two reports,
once for each end, and a link that one repo's Apply added and a later one removed is listed in
neither. The calls counts beside it are the repo's own.

## Speed

Measured on the build machine (2 shared CPUs) on the field-shaped estate at 60 repos (38
services, 22 proxies; the 33 services read from facts applied), CPU time of the process,
`ATTICUS_BENCH=1` (`apply-one-build.test.ts`):

| What                                       | CPU s                                |
| ------------------------------------------ | ------------------------------------ |
| One repo's Apply (`verify <repo> --write`) | 4.5 (4.3 to 5.5 over the runs)       |
| `verify --all --write`, 33 repos, before   | about 33 times that, 140 to 180      |
| `verify --all --write`, 33 repos, now      | 20.1, one build: 4.5 times one Apply |

The plan asked for the run under three times one repo's Apply. The first version took 21 to 27
CPU s, four to six times. The run now reads the questions and the estate's facts once, and again
only after a repo's questions changed a question file's text (`questionStats.writes`, counted where
a question file is written). That is what each repo's own Apply would read at its turn, so it
changes no byte. On this estate the questions change at most repos, so they are read again about
every other repo. The rest of each repo's own work after the build stays: its target, host and
topic questions, its terms and its map, about 0.3 CPU s a repo. Verifying the 33 repos is about
5 CPU s, and the one build and its write about 4. The bench's budget is six times, the measured
4.5 plus a third.

## Not changed

- `atticus map --all`'s estate join (`packages/cli/src/map-all.ts`) has its own loop over
  `verifyCommand` and still builds once for each repo. It can use `writeManyFactsIntoCatalog` the
  same way; left for a follow-up.
- ADR 0207's "Before it starts" panel is not built. Its Builds row would now be 1 for
  `verify --all --write`, and its Undo row would say the run is one undo step.

## For build-status.md and codebase-map.md

- build-status: v31 "One build for many repos": built (gate 2). Tests:
  `packages/cli/test/apply-one-build.test.ts` (one build and the same catalog, a later repo that
  moves what an earlier one calls, a refused repo, a refused build, a held file in the one write,
  a repo's own file failing after it, `--json`'s run, a prototype, Stop, one repo; the CPU budget
  under `ATTICUS_BENCH=1`), `apply-one-build-answers.test.ts` (an answer opened again) and the
  one-build Stop cases in `packages/cli/test/apply-all-stop.test.ts`.
- codebase-map: `packages/cli/src/verify-commands.ts` `verifyAllCommand` holds each repo's write
  and hands them to `writeManyFactsIntoCatalog` (`packages/cli/src/map-render-commands.ts`), which
  shares `writeFactsIntoCatalog`'s path (`writeFactsOf`): the lock, the catalog read, the one
  build (`buildCatalog` with every repo's snapshot), `buildAndWrite`, then each repo's files.
