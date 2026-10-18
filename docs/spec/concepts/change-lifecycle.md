# The change lifecycle

A change moves from an idea to a release through phases, with a person approving each hand-off.

## Phases

Define (product owner) → Design (architect) → Plan (analyst and team lead) → Build → QA →
Release. A change type in the org pack can add, skip or reorder phases and set who approves
each.

The change lives in `openspec/changes/<change-id>/`: its brief and proposal, specifications,
interfaces, mappings, data design (when a data store is touched), design, stories, tasks and
service-desk drafts; the repositories it touches (`repos.yaml`); its findings (`review/`); and
its state (`change.yaml`, see [C4](../contracts/c4-plugins-workspace-and-api.md#changelifecycle)).

## Hand-offs

Each hand-off opens one pull request on a branch `handoff/<change-id>/<phase>`. The code owners'
approvals are the approval; once given, the pull request merges and the change moves to the next
state. "Request changes" keeps the same pull request; "return" closes it and moves the change to
`returned`. An open blocking finding on the phase's gate stops the hand-off.

## States

`draft`, `define`, `design`, `plan`, `build`, `qa`, `release-ready`, `released`, `archived`,
plus `returned` and `post-release-review`. Every transition is recorded in the change's history
with who, when, the pull request and the reason.

## After release

Releasing archives the change and rescans, so the catalog shows the ecosystem as it now is, and
the specifications the change carried become the current ones.
