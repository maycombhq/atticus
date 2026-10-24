# 0123. Branches you can see and choose (C6, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-24
- Builds on: ADR 0016 (the workspace), 0047 (guided setup), 0074 (results per commit), 0119 (one experience on every surface)

## Context

Each repo in a manifest names one `defaultBranch` (default `main`):

- `repos discover` fills it from the clone's `HEAD`, or a person types it.
- Every scan reads the base clone at that branch.
- Other branches appear only as a change's `change/<id>` worktree, or with `change conform --ref`.

Nobody sees which branch the catalog describes. Nothing says when the remote calls another branch its default. There is no way to read `develop` or a release branch to see what it would bring.

## Decision

### 1. Detect, don't guess

- Every `workspace sync` asks the remote which branch it calls its default (`git remote set-head origin --auto`) and keeps the answer in the base clone (`refs/remotes/origin/HEAD`).
- When it isn't the manifest's `defaultBranch`, sync says so.
- `doctor` and the Repos screen read the answer offline, with no network call.
- Atticus never changes `defaultBranch` by itself: a person decides which branch is the baseline.

### 2. Other branches, scanned beside the baseline

- A manifest repo may list `branches`: the other branches people work on. The list is optional with a default of `[]`, so every v1 file stays valid.
- `atticus scan --ref <branch>` scans every repo that lists the branch; `--repos a,b` names repos instead. Each repo's branch is checked out read-only beside its base clone, in `workspace/.branches/<repo>/<branch>/`.
- The catalog is kept in `catalog/branches/<branch>/generated`, with `branch.yaml` recording the branch, when it was scanned, and each repo's commit.
- The scan compares it with the baseline's records from the same repos: what the branch adds, removes and changes.
- One rule holds: the catalog of the default branch is **the** catalog, the baseline the hand-off PRs build on. A branch is compared with it, never merged into it. The index reads only `catalog/generated` and `catalog/curated`.
- A branch scan reads code only. `inputs/` and other metarepos belong to the baseline.

### 3. A Repos screen (Set up › Repos)

For each repo it shows:

- its URL, type and owner;
- the default branch, with the commit the baseline was read from;
- the remote's default, when it differs;
- the other branches, and those scanned, with when and at which commit.

Actions:

- **Scan** a branch: the scan job with `ref`.
- **Compare** it with the default branch.
- **Edit branches**: writes the manifest, keeping its other fields and comments, and says to commit it in a pull request.

VS Code's repo rows show the branch and the scanned commit. IntelliJ shows the same screen in its tool window.

### 4. Limits

- Atticus reads from base clones and its own checkouts only. It never checks out a branch in a person's own clone, and never pushes.
- A branch's catalog is never the baseline.
- A change's own branch and base, per repo, are on its cockpit (This change › At a glance).

## Consequences

- People can see which branch the catalog describes, and what `develop` would bring, without changing the baseline.
- The manifest's `branches` is the one new field, listed in the local API's `RepoView`.

## Built

- Item 1: `workspace` `remoteDefaultBranch` and the sync's `remoteDefault`; `workspace sync`'s warning; doctor's `default-branches` check.
- Item 2: `ManifestRepo.branches`; `workspace` `checkoutBranch` and `branchCheckoutPath`; `cli/src/branch-scan-commands.ts` (`scan --ref`).
- Item 3: `GET /api/repos/branches`, `GET /api/repos/compare`, `PUT /api/repos/{id}/branches` (`cli/src/repo-branches.ts`, `ui-api-repos.ts`); the scan job's `ref`; `ui/src/screens/run/Repos.tsx`; VS Code's repo rows (`sidebar-data.ts`).
