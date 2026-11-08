# 0184. The release PRs take the change to the default branch

- Status: proposed (built from the seventh UX walk, 2026-11-08; for the product owner to accept)
- Date: 2026-11-08
- Builds on: ADR 0036 (task PRs merge `task/<change>/<task>` into `change/<change>`), ADR 0073 (a gate is approved when its hand-off PR merges), ADR 0032 (a manual Git host turns writes into steps), ADR 0074 (facts verified from code decide; the readers only cross-check)
- Contracts: C4 (local API 2.70.0) adds `POST /api/changes/{changeId}/release-prs`. Additive. No catalog, rule or org-pack schema changes: repos.yaml already has `pr`.

## Context

The seventh UX walk took a change through go/no-go to RELEASED and then to the archive. Every code repo's default branch was still the commit the change started from. Task PRs merged into `change/<change>` (ADR 0036), but nothing ever raised the PR from `change/<change>` into the default branch. Atticus opens PRs in three places only: the hand-off (`packages/changes/src/handoff.ts`), Propose for review (`packages/cli/src/propose.ts`) and task runs (`packages/taskrun/src/run.ts`). The change's `repos.yaml` never got a `pr`, and the archive gate checked a repo's PR only when there was one, so it didn't block.

The same walk found the archive gate blocked by catalog drift that wasn't there. It ran the built-in readers on the change's stale worktree and reported calls "no longer in the code" that the code still had. The facts verified from code decide (ADR 0074). The readers are a cross-check.

## Decision

1. **A release PR per code repo.** For each repo in the change's `repos.yaml`, Atticus opens one PR from `change/<change>` into the repo's default branch, as the Git host names it. It records `pr` (number, link, state) in `repos.yaml`. A repo whose release PR is open or merged keeps it. A repo whose release PR was closed on the host gets a new one. A repo whose change branch has no commits beyond the default branch has nothing to release, and Atticus says so.
2. **Where it sits.** The release PRs are raised once the build is done: in QA, or in the release phase, before go/no-go. Go/no-go is decided over the PRs that will ship. Raising the go/no-go hand-off waits until each repo has a release PR, merged, unless the org pack's `process/ci.yaml` says `archive.requireMergedPrs: false`. In that case the PR only needs to be raised. A change that is already released can still raise them, so a change released before this ADR isn't stuck.
3. **The person's click is the approval.** It is `atticus change release-prs <id> --approve` on the command line, and **Raise the release PRs** on the Release page. The approval is recorded as theirs. A Copilot session can't run the command with `--approve`: the person-only list refuses it.
4. **Atticus pushes nothing to the default branch.** The change branch is already on the host once task PRs have merged into it. Only when the host doesn't have it does Atticus push the change branch, by name and never forced. The worktree's copy never goes over the host's. Atticus refuses a change branch that is protected or is the default branch, and anything that isn't `change/<change>`.
5. **A person merges on the host.** Branch protection and CODEOWNERS decide who. Atticus never merges a release PR and never deploys. **Sync** (`atticus change sync`) reads each release PR back from the host and records it as merged or closed. When the host reports checks, Sync records them as the repo's build.
6. **A manual Git host** (ADR 0032) records each release PR as a Manual step, as it does the hand-off and task PRs. The person opens the PR on the host and records its real link and number on the step. Sync then takes the link.
7. **The archive gate.** Each repo needs its release PR merged (with `requireMergedPrs`, as before). What shipped is the merged commit: the commit the repo's clone is at once synced, or the commit its pipeline's drift report scanned. A repo the assistant read must have its facts (`facts/<repo>.jsonl`) read at that commit, and the catalog written from them. If the facts are of another commit, the blocker says to read the repo again (Map › Trust › Freshness, or `atticus map <repo>`), not that the catalog drifted. If the clone is still where the change started though the PR merged, the blocker says to sync first. The readers' drift on such a repo is a note. A repo the assistant never read keeps its readers' catalog, so the readers still decide its drift, now on the clone of the default branch and never on the change's worktree.

## Consequences

- A released change's code is on each repo's default branch, by PRs people merged. `repos.yaml` says which PR shipped it.
- Go/no-go now has one more step before it: raise the release PRs and merge them. The Release page lists each repo's release PR with its state and checks.
- After the merge, a repo the assistant read is read again at the merged commit before the change is archived. That is the freshness step a team already takes after any merge.
- Product owner to decide: whether go/no-go should wait only for the release PRs to be raised and approved, merging after the go (the walk's reading of "over the PRs that will ship"), rather than merged as built here. `requireMergedPrs: false` gives the raised-only behaviour today.
