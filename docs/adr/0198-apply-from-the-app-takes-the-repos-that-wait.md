# 0198. Apply from the app takes the repos that wait

- Status: proposed (2026-11-16), for the product owner to accept
- Date: 2026-11-16
- Release: the patch after 2.0.0-beta.28.3
- Amends: ADR 0188 (the route `POST /api/facts/apply-all`)
- Contracts: C4 only, additive (Local API 3.16.0). One optional request field and three optional result fields. No catalog, rule, plugin, AI runtime or org-pack schema changes, and no file format changes. `atticus verify --all` is unchanged on the command line.

## Context

The map's bar (`CorrectionsToApply`) lists the repos whose corrections are newer than their last Apply. With one repo waiting it offered "Apply to <repo>'s map". With two or more it offered only "Apply to every repo's map", which posted `POST /api/facts/apply-all`, and that ran `atticus verify --all --write`: every repo that has a facts file, one after another, each with its own catalog build.

On an estate of 40 repos read, with corrections waiting in a few, the owner clicked it at 9:12 and it was still running at 14:00. One repo's Apply took about ten minutes there (a separate fault in the build's speed). The run said nothing about how many repos it had done or had left, and there was no button to apply one of the waiting repos on its own.

"Every repo" was the wrong set for that bar. A correction changes its own repo's facts, and each Apply already builds the catalog from every repo's slot, so applying the repos that wait is enough to draw their corrections.

## Decision

1. `POST /api/facts/apply-all` takes an optional body, `{ repos?: string[] }` (`FactsApplyAllRequest`).
   - With `repos`, only those repos are applied. The server checks every name against the repos that have a facts file. If one has none, it answers 400 and starts no job. The page then reads the list again.
   - The order is fixed: id order, whatever order the list came in. Duplicates count once.
   - Without `repos` the route does what it did: every repo read so far. The step a page names as `atticus verify --all --write` (after a declaration or an owner set) still uses it that way. Its button says how many repos that is ("Apply to all 40 repos read", the count from Map › Trust's read), and with more than five it says under the button that each is applied in turn and where to watch.
2. The job's result (`FactsApplyResult`) gains `applied` and `notApplied`: the repos by name, each in id order. A repo that wrote with rejected facts left out counts as applied, as it does for one repo's Apply (beta.28.1).
3. While the job runs over several repos, its existing `progress` counts them: `total` is the number of repos and `done` is how many have finished; its message names the repo being applied. The Console and the strip under the top bar already show `done of total` for any job. Each repo's start is also printed as a line, with an estimate of the time left once one repo has finished.
4. The map's bar and Home send the repos that wait. They also offer each waiting repo its own Apply.
5. The command line does not change. `atticus verify --all [--write]` means every repo read so far. No flag passes a list; a person names one repo with `atticus verify <repo> --write`.

6. Stop is heard between the repos of a run. Before this ADR a job's Stop was heard until its first catalog write started and never again, so a run over several repos could not be stopped once its first repo had written. Now:
   - Stop asked while repo K is being written lets that write finish whole. The run then ends before repo K+1 starts. The job answers once, however often Stop is pressed: "Stop heard: the run ends when this repo's write has finished." From then until that write ends, the job's state is stopping and its progress message is "Stopping after this repo…", so the Stop button, the strip and the map's bar all show that the Stop was heard.
   - Stop asked while repo K is still being read or built ends the run there. Nothing of repo K is in the catalog, as with one repo's Apply.
   - Stop asked during the last repo's write is too late, as before, and the run ends done.
   - A stopped run's job ends `cancelled`, never failed. Its result has `stopped: true`, the repos applied whole under `applied`, and the repos not applied (those never reached included) under `notApplied`. The scan's lock is free.
   - The mechanism is a release beside the commit point: work made of several writes says when one has ended (`releaseCurrent` in `packages/core/src/cancel.ts`, `release` on the job in `packages/server/src/jobs.ts`). Only the run over several repos calls it, and only between two repos. That run's job is started as one of several writes (`severalWrites` in the job's start options, with its words), which is what makes it answer a Stop during a write as above. Every other job is unchanged: past its commit point it is never stopped, and it says "Stop came after the write had started" each time, as before.
   - Closing the app during such a run counts as a Stop. The process stays alive while a job's work runs, so before this the run went on through every repo with no app to show it. Now the repo being written finishes whole and the run ends there.
   - On the command line `atticus verify --all --write` has no Stop of its own. Ctrl+C ends the process, as it did.

## Why a list from the page, and not "the repos that wait" worked out by the server

The page shows the person a list and a button that says how many repos it will apply. If the server worked the set out again when the job started, a correction saved in between (by a colleague's pull, an assistant or the command line) could add a repo the person did not see. Sending the list makes the click mean what the page said. The server still checks each name, because the list comes from a browser.

## What does not change

- One local step at a time. A second Apply while one runs is refused with 409, as before.
- Each repo is still applied by `verify <repo> --write`, with its own build, guards, undo copy and lock. A repo whose build is refused, or whose facts are rejected, is reported as before and the run goes on to the next repo.
- A write is never cut short. Stop asked while a repo's catalog write is under way still lets that write finish whole (beta.28.1), for one repo's Apply and for a run over several.

## Compatibility

- An older page that posts no body gets every repo, as before.
- A newer page against an older server: the older server ignores the body and applies every repo. The page's button would then say fewer repos than it applies. The app and its server ship together in one package, so this happens only with a hand-built mix.
- The new result fields are optional. A reader that does not know them ignores them.
