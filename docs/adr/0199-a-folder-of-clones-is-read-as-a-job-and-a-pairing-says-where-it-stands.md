# 0199. A folder of clones is read as a job, and a pairing says where it stands

- Status: proposed (2026-11-16)
- Date: 2026-11-16
- Release: the next beta after 2.0.0-beta.28.3
- Contracts: C4, the local API, additive only, in version 3.16.0 (shared with the apply-from-the-app decision, numbered 0198 on its own branch and merged beside this one; these additions are part of the same 3.16.0). No stored file changes, so there is no migration. C1, C2, C3, C5, C6 and the facts file are unchanged.

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

### 5. A paired call says where it stands

What the data meant, as read in the code: a call's `paired` status is a person's `link` line in the repo's corrections file **with this box** (`pairedHere` in `packages/core/src/link-candidates.ts` already compares the box), and it is given before the catalog is looked at, so a call paired with this box was `paired` whether or not the map had its arrow. A call a person paired with **another** box was never `paired`: it is `joined` (the map draws it there) or `undrawn` (it doesn't yet), with `pairedBy` and `joins`. So "every call is paired with this box by a person already" named the right box, and was silent on the one thing the person was looking at: the arrow.

Applied is told from the catalog, not from a clock:

- `CandidateCallView.drawn` (new, optional, for `paired`): true when the built catalog has the arrow to this box (a current Interface, not suppressed, whose caller evidence cites the call's line and whose `to` is this box, else the join's own Interface id in the catalog), false when it doesn't. An old arrow of the same call to another box is not this pairing's arrow. With no catalog built, false.
- `LinkCandidatesView.applyPending` (new, optional): the repo's corrections file is newer than its last Apply, by the rule a proposal's `applyFirst` already uses (the corrections file's time against the repo's spec header, else its `verify.yaml`).

`drawn` decides what is said; `applyPending` only chooses the words for "not drawn". A file's time alone would have been wrong on the reporting estate: an Apply that is stopped after it rewrote the repo's files and before the catalog was built leaves the files newer than the corrections and the map without the arrow.

The panel (`PairedStanding` in `Connect.tsx`) says, from the copy file:

| Where the calls stand                                                       | What is said                                                                                                | What is offered                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Paired with this box, on the map                                            | how many, and that the arrow from A to B is on the Estate map                                               | how to undo one                                 |
| Paired with this box, not on the map, corrections newer than the last Apply | how many, that the pairings are in A's corrections written since A was last applied                         | Apply to A's map, right there                   |
| Paired with this box, not on the map, though A was applied since            | that the Apply may have been stopped or refused before it wrote the map, or the link was deleted on the map | Apply to A's map, which says what it leaves out |
| Some on the map, some not                                                   | how many of each                                                                                            | Apply to A's map                                |
| Paired with an API the box no longer has                                    | that no arrow can be drawn                                                                                  | undo, then pair again                           |
| Paired by a person with another box                                         | how many, and each box with its count                                                                       | pair here (replaces their word), or how to undo |

A row of a call paired with another box that the map doesn't draw yet says whose pairing it is, not only that "the read ties it" there.

Edit the map's "has no call left to pair with this box: each is paired by a person already" had the same fault and a second one: it was also said of calls nobody paired (they go to the box by the code's own arrow) and of a repo with no call at all. It now says how many go there already by an arrow read from the code, how many a person paired that are on the map, and how many wait for the repo's Apply.

### 6. After the review of the pairing panel (2026-11-16)

- **A module's component is in its repo's box.** A call paired with an API in a module of the other repo has its arrow drawn to the module's component; the box list knew only the repo's id and its own component, so such a pairing read as "not on the map" for ever (reproduced with a real catalog, `packages/cli/test/ui-api-links-modules.test.ts`). The box's names now include its modules' components.
- **An arrow is told by the join's own Interface first.** The catalog having the Interface id the join gives this call and this entry is the exact answer. Failing that, any of the boxes an Interface citing the call's line goes to: two calls cited on one line each have an arrow, and all their boxes are kept, not the first.
- **Who paired is said, and the AI is never "a person".** A `paired` call carries `pairedBy`; any call with a pairing carries `pairedAi` when the pairing is the AI's (ADR 0181). The sentences name the people, and say "AI (not confirmed by a person)".
- **Both ends in one component.** Such a pairing draws no arrow between boxes, ever (`inside`). The panel says so and offers no Apply for it.
- **A call that goes to this very box** (a repo drawn inside the system box being viewed) is not "paired with another box".
- **The panel reads the calls again after its own Apply** (`onWorkChanged`), while a pairing waited.
- **Edit the map's "no call left"** says only what is known: that calls go there already "with an arrow on the map" (not how they were joined), that the repo's facts aren't verified or read with the command, that its calls are of a kind that isn't paired, or, for a redirect, that its facts hold no call.

### 7. After the review of the folder read (2026-11-16)

- **`atticus repos discover --json` changed shape for a folder that mixes listed and new repos.** A repo a manifest lists already used to be in `repos`; it is now in `listed` (`path`, `id`, `url`) and not in `repos`, and `questions` holds none about it. A script that counted `repos` to learn how many clones a folder has must add `listed`. A folder of only new repos prints what it printed.
- **One repo written two ways is one repo, and nothing else is** (`cloneUrlKey`, `packages/workspace/src/repo-ids.ts`): `\\` and `/`, a percent-encoded name, and a scheme's own default port. Another port and an encoded slash are not the same repo. What one Git host calls the same repo under two addresses (Azure DevOps' https `_git` form and its `ssh.dev.azure.com:v3/…` form, the older `visualstudio.com` host) is **not** told yet: that is a host's knowledge, which ADR 0035 keeps out of the core packages (`check-core-neutral` refuses it in `workspace`), and no Git host adapter has a place for it today. Until one does, a clone whose origin is the ssh form of a repo the manifest lists by its https form is read again and offered as new (with `-2` if its id is taken), never hidden.
- **A folder that can't be listed** (not there, a file, no permission) is refused in words that name it and say what to do.
- **The page** takes the last read's list away as a new read starts, stops its job when it goes, and gives each skipped folder a row.
- **`job: true` and an older server.** The request schema is strict, so a server older than 3.16.0 answers 400 to `job`; the page and its server ship together.
- **The matcher is compared with the one it replaced** on seeded globs, paths and `.gitignore` files in `packages/core/test/glob-differential.test.ts`, the old one kept as `packages/core/test/glob-old.ts`.

## Consequences

- A second read of the same folder costs one `git config` a listed clone.
- A folder whose clone has no origin and isn't listed by its path is read, as before.
- QUESTIONS.md no longer asks who owns a repo the manifest already has an owner for.
- Reading the candidates costs one more `stat` of two small files. Nothing new is read from the catalog: `drawnOf` already read it.
- The 60 s bound is not a setting. A clone too large to list in a minute can still be added by its clone URL, which reads nothing.

## Not verified

- The reported case itself (an Apply stopped part way on the owner's estate) was not reproduced: the tests cover a pairing written and not applied, and the same one applied, on the invented token-host estate with a real catalog.

- No run in a browser, and none on Windows, where a folder's listing costs more than on Linux. The generated folder is not the owner's estate: the cause was found by measuring, and it matches the report's shape (time growing with files × `.gitignore` lines), but the owner's own folder was not read.
