# 0006. Depend only on OpenSpec's stable core

- Status: accepted
- Date: 2026-10-18

## Decision

Atticus uses OpenSpec's stable core (specs, changes, schemas, instructions, status, validate, archive) through one adapter with contract tests and a pinned version range. It does not depend on OpenSpec's beta stores or worksets; the multi-repo layer (change workspaces, worktrees, cross-repo tracking) is Atticus's own. Existing stores are read if present.

## Addendum (2026-10-25): stores, read and written as a beta format

"Existing stores are read if present" is now built, behind switches that are off by default (ADR 0126). Atticus still depends on no beta feature. It can make the metarepo an OpenSpec store (`atticus init` or `atticus upgrade` with `--openspec-store` writes `.openspec-store/store.yaml`). It can add the metarepo to a code repo's `references:` at hand-down (`org-pack/openspec.yaml` `referenceInRepos`). It reads the stores `org-pack/openspec.yaml` names, read-only and labelled, in `atticus change list`, `atticus openspec check` and `atticus feature spec`. The store format is beta: its shape is kept in `packages/openspec-adapter/src/stores.ts`, read tolerantly, and checked against the pinned OpenSpec by contract tests. `atticus doctor` says when the installed OpenSpec has no stores. Registering, cloning, pulling or pushing a store, `store:`-only repos and worksets stay out.
