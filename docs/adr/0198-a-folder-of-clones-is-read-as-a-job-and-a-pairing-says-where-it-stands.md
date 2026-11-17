# 0198. A folder of clones is read as a job, and a pairing says where it stands

- Status: proposed (2026-11-16)
- Date: 2026-11-16
- Release: the next beta after 2.0.0-beta.28.3
- Contracts: C4, the local API, additive only: version 3.15.0 to 3.16.0. No stored file changes, so there is no migration. C1, C2, C3, C5, C6 and the facts file are unchanged.

## Context

Two field reports came from one 40-repo estate on 2.0.0-beta.28.3 (a Windows laptop). Both are a page that didn't tell the person the truth about what the product was doing.

**"Discover a folder of clones" took hours and said nothing.** Set up › Repos › Add repos posts `/api/setup/repos/plan`, which ran `reposDiscover` inside the request. The person gave the folder that holds all ~40 clones, to add three new ones.

Measured on a generated folder (Linux, 2 cores; 43 invented Forge clones: 40 of 3,000 source files each with a 300-line `.gitignore`, and three large ones with `node_modules`, `target`, `build`, `venv` and coverage folders, two with 3,000 commits of history): the read took **326 s**. One clone of 5,000 files with a 300-line `.gitignore` took 11.1 s, one of 10,000 files 23.9 s, and the same 5,000 files with a 30-line `.gitignore` 1.4 s.

So the time was not the build output or dependency folders (they are skipped by name and by `.gitignore`), not Git (one `git config` a clone, no history is read), and not the type detection's own globs. It was the walker every reader of a checkout shares (`walkRepo`, `packages/core/src/repo-files.ts`): each file is matched against **each line of the clone's `.gitignore`**, by the linear-time glob automaton (`packages/core/src/glob.ts`), which made a new set of states for every character of every path. Files × `.gitignore` lines × path length: about 7 microseconds an answer, 1.5 million answers for one mid-sized clone. A real estate's clones are several times larger than the generated ones, and the read of the 37 repos already in the manifest was pure waste.

The request also had no progress, no Stop and no bound, so one slow folder held everything and the page looked dead.

**"It says it's already paired, but I don't see the line."** The Connect panel said "Every call of this repo is paired with <box> by a person already". A call's `paired` status means a person's `link` line is in the repo's corrections file; it says nothing of which box the line points at, nor of whether the catalog has it yet. On that estate an Apply had been stopped, so the corrections file was ahead of the catalog and the map had no arrow. (Decided in the second part of this ADR.)

## Decision

### 1. The matcher answers as before, about a hundred times sooner

`globMatcher` keeps its automaton and its guarantee (no glob can backtrack; time is linear in the path), and:

- a glob that is a plain name, `*.ext` or `name*` (most `.gitignore` lines) is told by the path's own end or start, with no automaton (`packages/core/src/glob-plain.ts`); a path with a line end in it is left to the automaton, whose `**` never spans one, so the answer is the same for every path;
- a path that doesn't hold the plain text every match of the glob must hold is no match, told before the automaton runs;
- the automaton remembers each set of live states and each step from one, so a step is worked out once a matcher, not once a character of every path. What a matcher remembers is bounded (4,096 sets and steps); past the bound a step is worked out each time, as before.

`ignoredBy` reads the rules from the last back and stops at the first that matches (the last matching line decides, as before).

The same 43-clone folder now reads in about **3 to 4 s**; the 5,000-file clone in 0.3 s. The scan and the code tools use the same walker, so they gain the same.

### 2. A repo a manifest lists already is told before it is read

`reposDiscover` reads the manifest first. For each folder it asks Git for the clone's origin (`git config`, one small file, no network; an in-place repo by its path) and, when a manifest lists that clone URL, records the folder in `DiscoverResult.listed` and reads nothing of it. The app passes every platform's repos (`known`). Such a folder is no longer in `repos` and no owner question is asked about it.

For a folder of only new repos the result is unchanged: the existing discover tests pass as they are, and the results on the generated folders are byte for byte those of 2.0.0-beta.28.3.

Each folder is also detected once, not twice, and a nested clone or a hidden folder is not walked rather than walked and left out.

### 3. One folder may take a minute

`repoTimeoutMs` (default 60 s). A folder that takes longer is skipped with "took too long to read (over 60 seconds); add it by its clone URL", in `skipped`, and the rest are read. The walk itself stops: nothing keeps reading the folder in the background.

### 4. The read is a job when the page asks

`POST /api/setup/repos/plan` takes `job: true`, the pattern of API 3.9.0 and 3.14.0 (`answerAsJob`, `callAsJob`): 202 `JobAccepted` at once; the job says each folder as it comes to it ("Reading forge-ledger (4 of 40)…", or "forge-ledger (4 of 40): listed already as ledger, not read."), hears Stop between folders, and its result's `answer` is the `ReposPlanView`. The refusals the request knows at once (no such folder; several platforms and none chosen) still come as the answer. Without `job` the request answers as before, for an older page.

It is a `work` job, not a `local` one: it writes nothing, so it neither takes Apply's slot nor is refused while an Apply runs.

The page (`AddRepos.tsx`) follows the job: it says the folder it is on, offers Stop, and lists each skipped folder with why. `atticus repos discover <folder>` prints the same line a folder (progress: standard error, never among `--json`'s data) and "Already listed: <folder> (<id>)".

## Consequences

- A second read of the same folder costs one `git config` a listed clone.
- A folder whose clone has no origin and isn't listed by its path is read, as before.
- QUESTIONS.md no longer asks who owns a repo the manifest already has an owner for.
- The 60 s bound is not a setting. A clone too large to list in a minute can still be added by its clone URL, which reads nothing.

## Not verified

- No run in a browser, and none on Windows, where a folder's listing costs more than on Linux. The generated folder is not the owner's estate: the cause was found by measuring, and it matches the report's shape (time growing with files × `.gitignore` lines), but the owner's own folder was not read.
