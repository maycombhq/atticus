# 0044. Role views and the person's own file (C4, additive)

- Status: accepted
- Date: 2026-10-18

## Context

The plan gives nine core roles and four optional ones a view each: a home and seven or eight screens in the sidebar, with everything else under All screens. A view is chosen by the person or defaulted from a group the org pack maps (`roles.yaml` `mappings`). The plan is firm that a view decides what you see, never what you approve: approvals come from ownership (CODEOWNERS, and `roles.yaml` `approvals` for actions outside Git).

Atticus has no directory to ask which groups a person is in, and the local app needs somewhere to remember the view.

## Decision

- **The person's file.** `.atticus/me.yaml`, next to `.atticus/executors.yaml` and like it never committed, holds `groups` (the directory or work-tracker groups the person is in, written by the person or by setup) and `view` (the role they chose). Both are optional.
- **`GET /api/me`** returns the signed-in user, their groups, the view and where it came from (`chosen`, `group` with the group's name, or `pick` when nothing maps them and the app asks), the roles this organisation offers (core, enabled optional, custom with the role each is based on), the approvals they hold with why (named in `roles.yaml`, in a group it names, or in a group that maps to a role it names), and the CODEOWNERS patterns that name them or one of their groups.
- **`PUT /api/me`** (`view`) saves the view, keeping the groups. An unknown role, or an optional role the org pack doesn't enable, is refused (400).
- **Approvals ignore the view.** Choosing the Architect view grants nothing; a group mapped to `architect` grants what `roles.yaml` gives architects.
- **Role screens and the inbox are app logic,** not contract: `packages/ui/src/app/roles.ts` holds each role's screens, the artifacts it owns and the lifecycle state in which a change waits on it, and builds Home's "Waiting on you" from calls the API already has.

## Consequences

Every person sees a home made for their work without a directory connection. A team that wants groups filled in automatically can write `.atticus/me.yaml` from its own tooling during setup. The OpenAPI document carries the two calls.
