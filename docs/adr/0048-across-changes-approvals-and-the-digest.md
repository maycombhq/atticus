# 0048. Views across changes, approvals waiting, the digest and the field-mapping grid (C4, additive)

- Status: accepted
- Date: 2026-10-19

## Context

Each screen showed one change at a time. A team lead with five changes in flight opened each to see the tasks, a delivery lead each to see the requests, and nobody could ask "which blocking findings are open anywhere?". Approvals happen in the Git host, but nothing in the app said which hand-off PRs waited on you. The notify adapter existed with no flow behind it. API mappings showed `mappings.md` as text, with no grid and no comparison with what the catalog already maps.

## Decision

- **`GET /api/across?view=findings|tasks|stories|tests|requests|releases`** lists one view across every open change, each row with its change id, title and state. Findings sort open first, then by severity; releases put those at go / no-go first. Read-only. The app shows it on Changes (`#/changes?across=<view>`) with a word filter, and the change list gains a filter by words and state (Blocked means a blocking finding is open).
- **`GET /api/changes/{changeId}/mappings`** returns each hop of `mappings.md` (a level-2 section) with its field rows (source, target, rule, when missing), whether it says "No mapping change", and the catalog's `FieldMapping` records for the same interface (matched on method and normalized path). The API mappings screen shows it as a grid, with what is mapped today folded underneath.
- **`GET /api/me/approvals`** lists the open hand-offs whose reviewers name the signed-in person or one of their groups (and that they haven't approved), and their own hand-offs with changes requested. They head Home's "Waiting on you" whatever the view, and link to the PR: approving stays in the Git host, so there is no new write path.
- **Digest.** `.atticus/me.yaml` (the person's own, uncommitted file) gains `notify: { digest: off | daily | weekly, channel? }`, set from Settings (`PUT /api/me/notify`). `POST /api/me/digest` and `atticus digest --as <you> [--send]` build the digest: reviews waiting, hand-offs to revise, and blocking findings on changes the person owns. It is sent through the notify adapter only on `send`, with the person as the approver (`ref: digest:<you>`). With no notify adapter, or a manual one, it is shown and not queued as a step: a message to yourself is not a task for someone else. Atticus has no scheduler; a person who wants it daily runs `atticus digest --send` from their own scheduled job.

## Consequences

Leads see the portfolio in one list. People see the approvals they owe without watching the Git host. The digest is opt-in per person and never sent without that person's action.
