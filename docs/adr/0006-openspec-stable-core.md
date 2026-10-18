# 0006. Depend only on OpenSpec's stable core

- Status: accepted
- Date: 2026-10-18

## Decision

Atticus uses OpenSpec's stable core (specs, changes, schemas, instructions, status, validate, archive) through one adapter with contract tests and a pinned version range. It does not depend on OpenSpec's beta stores or worksets; the multi-repo layer (change workspaces, worktrees, cross-repo tracking) is Atticus's own. Existing stores are read if present.
