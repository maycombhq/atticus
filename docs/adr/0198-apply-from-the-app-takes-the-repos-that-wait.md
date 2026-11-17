# 0198. Apply from the app takes the repos that wait

- Status: proposed (2026-11-16), for the product owner to accept
- Date: 2026-11-16
- Release: the patch after 2.0.0-beta.28.3
- Amends: ADR 0188 (the route `POST /api/facts/apply-all`)
- Contracts: C4 only, additive (Local API 3.16.0). One optional request field and two optional result fields. No catalog, rule, plugin, AI runtime or org-pack schema changes, and no file format changes. `atticus verify --all` is unchanged on the command line.

## Context

The map's bar (`CorrectionsToApply`) lists the repos whose corrections are newer than their last Apply. With one repo waiting it offered "Apply to <repo>'s map". With two or more it offered only "Apply to every repo's map", which posted `POST /api/facts/apply-all`, and that ran `atticus verify --all --write`: every repo that has a facts file, one after another, each with its own catalog build.

On an estate of 40 repos read, with corrections waiting in a few, the owner clicked it at 9:12 and it was still running at 14:00. One repo's Apply took about ten minutes there (a separate fault in the build's speed). The run said nothing about how many repos it had done or had left, and there was no button to apply one of the waiting repos on its own.

"Every repo" was the wrong set for that bar. A correction changes its own repo's facts, and each Apply already builds the catalog from every repo's slot, so applying the repos that wait is enough to draw their corrections.

## Decision

1. `POST /api/facts/apply-all` takes an optional body, `{ repos?: string[] }` (`FactsApplyAllRequest`).
   - With `repos`, only those repos are applied. The server checks every name against the repos that have a facts file. If one has none, it answers 400 and starts no job. The page then reads the list again.
   - The order is fixed: id order, whatever order the list came in. Duplicates count once.
   - Without `repos` the route does what it did: every repo read so far. The step a page names as `atticus verify --all --write` (after a declaration or an owner set) still uses it that way.
2. The job's result (`FactsApplyResult`) gains `applied` and `notApplied`: the repos by name, each in id order. A repo that wrote with rejected facts left out counts as applied, as it does for one repo's Apply (beta.28.1).
3. While the job runs over several repos, its existing `progress` counts them: `total` is the number of repos and `done` is the repo it is on. The Console and the strip under the top bar already show `done of total` for any job. Each repo's start is also printed as a line, with an estimate of the time left once one repo has finished.
4. The map's bar and Home send the repos that wait. They also offer each waiting repo its own Apply.
5. The command line does not change. `atticus verify --all [--write]` means every repo read so far. No flag passes a list; a person names one repo with `atticus verify <repo> --write`.

## Why a list from the page, and not "the repos that wait" worked out by the server

The page shows the person a list and a button that says how many repos it will apply. If the server worked the set out again when the job started, a correction saved in between (by a colleague's pull, an assistant or the command line) could add a repo the person did not see. Sending the list makes the click mean what the page said. The server still checks each name, because the list comes from a browser.

## What does not change

- One local step at a time. A second Apply while one runs is refused with 409, as before.
- Each repo is still applied by `verify <repo> --write`, with its own build, guards, undo copy and lock. A repo whose build is refused, or whose facts are rejected, is reported as before and the run goes on to the next repo.
- Stop. A job's Stop is heard until its first catalog write starts and not after it (beta.28.1). In a run over several repos this means Stop is not heard between repos once the first has written. That is how the route behaved before this ADR. It matters more now that the run says how long it has left, so it is recorded here as a known gap. `docs/design/apply-once.md` describes it with the single-build design.

## Compatibility

- An older page that posts no body gets every repo, as before.
- A newer page against an older server: the older server ignores the body and applies every repo. The page's button would then say fewer repos than it applies. The app and its server ship together in one package, so this happens only with a hand-built mix.
- The new result fields are optional. A reader that does not know them ignores them.
