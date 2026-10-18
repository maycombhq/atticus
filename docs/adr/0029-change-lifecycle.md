# 0029. The change lifecycle and change.yaml

- Status: accepted
- Date: 2026-10-18

## Decision

Each change's lifecycle lives in `openspec/changes/<id>/change.yaml`, next to OpenSpec's artifacts. It is a new contract file (`ChangeLifecycle`, schema version 1, JSON Schema in the workspace group), written only by `@maycombhq/changes`: canonical YAML, temp file then rename. It records id, title, change type and template; the state (`draft`, a phase state, `release-ready`, `released`, `post-release-review`, `returned`, `archived`, the same values as the API's `ChangeState`); owners by role, systems and touches; the authors of each artifact; a history chain of every transition (from, to, at, by, pr, reason) that must end at the current state; and every hand-off PR (phase, branch `handoff/<id>/<phase>`, PR, state, raiser, reviewers, the approvals that counted, the sha-256 of each file at hand-off), at most one open.

**State machine** from `change-types.yaml` (C6): each type's phases, artifacts and approvals. An artifact is due in the phase the change policy assigns, or the type's next phase after it (an emergency fix writes its proposal in Build); `data.md` only when a data store is touched. **Templates**: eight built-in briefs (feature, defect fix, emergency fix, tech debt, vulnerability fix, config/flag, data fix, decommission), overridable at `org-pack/process/change-templates/<id>.md`.

**Hand-offs** are refused until the phase's artifacts exist and are no longer the template, the newest critic round on the phase's gates has no open blocking finding, open knowledge gap or unreadable finding file, and (when personal data is touched) the privacy role exists. The PR opens through the C4 Git host adapter with the person's approval; required approvals are the union of the type's roles, the gate's approvers and minimum, the privacy role when personal data is touched, and extra approvals for the risk level. Sync merges only when those are met and the host's merge rules pass, then advances the state; Return to PO moves the change to `returned`.

**Separation of duties**: at release nobody who wrote any artifact of the change or raised the hand-off counts as an approver (not configurable); in other phases, the authors of that phase's artifacts don't count unless the policy allows it (by default only the product owner at Define); roles.yaml separation pairs apply. **Risk** is a deterministic score with every factor listed (type weight, extra systems, data stores, vendor boundary, interfaces planned for modify or retire); it picks the test-strategy row and any extra approvers. **Conflict detection** reports open changes touching the same systems, records or repos.

The organisation changes all of this through the org pack (`change-types.yaml`, `gates.yaml`, `roles.yaml`, `process/change-templates/`, `process/change-policy.yaml`), not code.

## Consequences

The lifecycle is auditable from files alone and runs end to end against mocks. Candidate additive contract changes for later: C4 `GitHost.closePullRequest` (today Return to PO comments on the PR and reports it still open on the host if the host can't close), and promoting `process/change-policy.yaml` into the C6 schemas. Not yet: running `gates.yaml` checks locally (they come from the PR's checks), enforcing the profile's mandatory critic rounds, and a rescan on archive.
