# 0183. The app runs the local steps and proposes them for review

- Status: accepted (the product owner's decision, 2026-11-08)
- Date: 2026-11-08
- Amends: build-status B1 ("the app shows the command to run next; it never runs anything itself"), already amended by ADR 0173 for an unattended Copilot run
- Builds on: ADR 0073 (a gate is approved when its hand-off PR merges), ADR 0124 addendum D-app, ADR 0149 (after a correction, the commands and what they change), ADR 0171 addendum (a session acts as no one)
- Contracts: C4 (local API 2.65.0) adds `POST /api/facts/{repo}/apply`, and `GET` and `POST /api/propose`. All additive.

## Context

The UX review (2026-11-08) walked each role's daily work in the app on a mapped estate. Most dead ends came from B1. Answering a question ended with "run `atticus verify <repo> --write`, then commit it for review". A correction, an audit, the baseline and the AI settings each ended with a `git add && git commit` line. A person who doesn't use git every day stopped there. The product owner decided that once setup is done, the app is where the daily work happens: it runs the local steps, and it commits and raises the pull request after the person's yes.

The same review found that the hand-off's branch was never pushed in production. `changeHandoff` asked the Git host for a PR from `handoff/<change>/<phase>` without putting the files there. The publisher existed but only tests passed it.

## Decision

1. **Local steps run on the person's click.** These are steps that write only in the metarepo and its clones: `verify <repo> --write` after an answer or a correction (**Apply**), the re-read of stale repos, opening a task's worktree (cloning first when needed), and the workspace sync. Each one shows what it ran and what it printed, as the command line would.
2. **Commit and propose.** The app's **Propose for review** button takes the metarepo files the person's work changed, under the folders that kind of work owns. Answers own `questions/`, `facts/` and `catalog/`. Corrections and the audit own `facts/` and `catalog/`. The org pack and settings own `org-pack/`. First it shows the list, the branch and the title (`GET /api/propose`). On the person's yes (`POST /api/propose`), it commits exactly those files onto the branch without touching their working tree, index or checked-out branch, pushes it, and opens the PR on the Git host. The person's click is the approval, recorded as theirs (ADR 0073). A manual Git host (ADR 0032) gets the PR as a step, as the hand-off does.
3. **The hand-off pushes its branch.** `change handoff --approve` (and the app's Raise hand-off) publishes the hand-off's files to its branch before it asks for the PR. If Atticus can't push (no remote, the practice sandbox), it says so and names the branch for the person to push. The PR or its manual step follows as before.
4. **What doesn't change.** A human approves and merges on the Git host: branch protection and CODEOWNERS decide who. Atticus never merges a proposal, never pushes to a protected branch and never deploys. None of this is open to a Copilot session: the person-only list refuses `--approve` and `--send`, and the app's server never runs with `ATTICUS_ACP_SESSION`.

## Consequences

- After an answer or a correction, the person's steps are Apply, then Propose for review, with no terminal. The rest of the review is the Git host's.
- Every pull request Atticus opens is one a person asked for, with the files they saw listed.
- The command line keeps every step for people who prefer it, and the app still shows the command beside each button.
