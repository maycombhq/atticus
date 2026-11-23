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
   The run says so: "Wrote the catalog for N repos in one build: … One undo step: atticus catalog
   undo takes the whole run back."
3. Then, repo by repo, each repo's contracts, specs, flows, questions, report and map are written
   as its own write writes them, and the rest of its verify lines are said.

So N repos cost one build instead of N. ADR 0207's "Builds: 38, one for each repo" becomes one
build, and a run of more than `UNDO_KEEP` (5) repos can be taken back with one undo.

- **One repo** (`--all` with one repo read, or the app's `only` list of one): exactly as before.
- **A refused one build** (a hand edit, removals past the count, a newer catalog, the lock held,
  a prototype repo in the run): nothing is written or said, and each held repo is written with its
  own build as before, so each refusal names its repo and its own next step.
- **Stop** before the one write (while repos are verified, or while the one build is built or
  checked): nothing of any repo is written, and the run says "Stopped before the catalog was
  written: none of the N repos was applied. Not applied: …". Once the catalog is being written,
  Stop is too late, as for the last repo of a run before.
- **A repo whose own files can't be written** after the one build (a file another program holds):
  that repo is said with its own command, as before; the others go on.
- **Progress**: "Repo N of M" and the time left at the rate so far are now mostly verifying, and
  say ", then one catalog build"; then "Writing the catalog once for N repos…" and the write's
  own steps.
- **Rollback**: `ATTICUS_APPLY_ONE_BUILD=0` in the environment restores the per-repo loop (each
  repo its own build), in the command and in the app's server.

## What is not byte for byte the same

Every file a commit sees is the same bytes as the same repos applied one after another (the
catalog, `build.json`, the facts snapshots, contracts, specs, flows, questions, maps), with one
exception: the `links` list in each repo's `facts/<repo>.verify.yaml`. A repo's own write lists the
links its build made, unmade or changed against the catalog its write found, which already had the
repos before it applied. One build has no write of one repo to tell a link by, so each repo's
report lists the run's link changes that have that repo at either end, and a link changed with
neither end in the run is listed in every report. No link a sequence of Applies lists is missing
(the tests check this); a link may be listed in two reports (once at each end), and a link that
one repo's Apply added and a later one removed is listed in neither. The calls counts beside it
are the repo's own, as before.

## Speed

Measured on the build machine (2 shared CPUs, load 5 to 9) on the field-shaped estate at 60 repos
(38 services, 22 proxies; the 33 services read from facts applied), CPU time of the process,
`ATTICUS_BENCH=1` (`apply-one-build.test.ts`):

| What                                       | CPU s                       |
| ------------------------------------------ | --------------------------- |
| One repo's Apply (`verify <repo> --write`) | 4.3 to 5.5                  |
| `verify --all --write`, 33 repos, before   | about 33 × that, 140 to 180 |
| `verify --all --write`, 33 repos, now      | 21 to 27, one build         |

The plan asked for the run under three times one repo's Apply; it is four to five times. Of a
run's 23 to 27 CPU s, verifying the 33 repos is about 5 and the one build and its write about 4;
the rest is each repo's own work after the build, about 0.4 CPU s a repo: the questions and the
estate's facts read for its questions (about 0.12), its terms (0.09), its other questions (0.1)
and its map (0.07). Each grows with the estate, so the run grows a little faster than the repos.
Taking it further means reading the questions and the estate's facts once for the run instead of
once for each repo, which changes what a repo's questions are worked out from (an answer reopened
by an earlier repo), so it is not done here. The bench's budget is six times.

## Not changed

- `atticus map --all`'s estate join (`packages/cli/src/map-all.ts`) has its own loop over
  `verifyCommand` and still builds once for each repo. It can use `writeManyFactsIntoCatalog` the
  same way; left for a follow-up.
- ADR 0207's "Before it starts" panel is not built. Its Builds row would now be 1 for
  `verify --all --write`, and its Undo row would say the run is one undo step.

## For build-status.md and codebase-map.md

- build-status: v31 "One build for many repos": built (gate 2). Tests:
  `packages/cli/test/apply-one-build.test.ts` (one build, the same files, a refused repo, a
  refused build, Stop, one repo; the CPU budget under `ATTICUS_BENCH=1`) and the one-build Stop
  cases in `packages/cli/test/apply-all-stop.test.ts`.
- codebase-map: `packages/cli/src/verify-commands.ts` `verifyAllCommand` holds each repo's write
  and hands them to `writeManyFactsIntoCatalog` (`packages/cli/src/map-render-commands.ts`), which
  shares `writeFactsIntoCatalog`'s path (`writeFactsOf`): the lock, the catalog read, the one
  build (`buildCatalog` with every repo's snapshot), `buildAndWrite`, then each repo's files.
