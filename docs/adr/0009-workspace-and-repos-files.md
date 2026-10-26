# 0009. Workspace layout, repos.manifest.yaml and a change's repos.yaml

- Status: accepted
- Date: 2026-10-18

## Decision

OpenSpec does not clone, track a change across repos, or know about worktrees, so this layer is Atticus's own (`@maycombhq/workspace`).

- **`org-pack/profiles/<platform>/repos.manifest.yaml`** lists every repo of a platform: id, URL, default branch, type, owner team, optional system, extractors, dialects, sparse paths, build command override, archived. Repo ids are unique across all profiles. URLs never hold passwords; Git's credential manager supplies credentials.
- **`openspec/changes/<change-id>/repos.yaml`** records, for one change, each repo's branch, base branch and base commit, worktree path, PR (URL, number, state) and last build. It sits beside OpenSpec's artifacts, which OpenSpec ignores, and is archived with the change.
- **`workspace/`** (git-ignored, anchored as `/workspace/`) holds base clones at `workspace/<repo>/` (partial clones of the default branch, fetched before scans, never edited) and change worktrees at `workspace/.worktrees/<change-id>/<repo>/` on branch `change/<change-id>`. If someone already pushed the change branch, the worktree continues from it.
- **Editor workspaces.** Each change gets `workspace/<change-id>.code-workspace` for VS Code and an IntelliJ project at `workspace/.intellij/<change-id>/`, listing the metarepo, the change's worktrees and its context pack, with relative paths. No editor plugin is needed.
- **Prune** removes worktrees whose PR merged or closed; a worktree with uncommitted work is kept unless forced. The editor workspaces go when no worktree is left.
- Both files are canonical YAML with JSON Schema generated from zod (`atticus schema export`).

## Consequences

Several changes run side by side without touching base clones or each other. Everything in `workspace/` can be deleted and rebuilt from the manifest and the repos files.

## Addendum (2026-10-26): what a repo is, in a person's words (ADR 0128, C6 workspace schema 2)

A manifest repo gains an optional `description`: one line (at most 300 characters) saying what the repo is, with `trust` (`verified` when a person wrote or confirmed it, `suggested` when the assistant drafted it and nobody has), `by`, `at`, and `cites` for a draft. `WORKSPACE_SCHEMA_VERSION` is 2, and `schemaVersion` on all five workspace files is now the union of 1 and 2 overwritten to 2 in memory, so every version-1 file stays valid and readers accept it as it is; `atticus upgrade`'s `manifest-schema-v2` rewrites the number, keeping comments. See ADR 0128 for where it is entered, how a draft is confirmed, and what reads it.
