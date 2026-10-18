# 0032. Manual adapters: when Atticus can't reach a system, a person does the step

- Status: accepted (direction from the product owner, 2026-10-18); built in M3 (adapters and planning) and M4 (UI)
- Date: 2026-10-18

## Context

In the target organisation the work tracker (ADO), the service desk (ServiceNow) and sometimes the Git host or the wiki may not be reachable from Atticus: no API access, no service account, or a network boundary. The workflow must still run end to end.

## Decision

1. **A `manual` adapter type for every external system** (work tracker, service desk, Git host, wiki, notifications, design tool). In C6 `runtime.yaml` each adapter may be `type: manual`, an additive enum value; it is also what Atticus falls back to when a configured adapter is unreachable or its credentials are missing.

2. **Writes become instructions.** Where a live adapter would create or change something (an ADO story, a SNOW request, a PR, a comment, a notification), the manual adapter produces a step for a person instead: what to create, where, and every field ready to copy (title, description, acceptance criteria, assignment group, CI item, links), plus a one-click export (text, CSV, or the system's import format where it has one). The step appears on the person's Home and in the change's task list in the UI, and as a checklist in the CLI (`atticus todo`). The person does it in the real system and records the result back (the new ADO id, the SNOW number, the PR URL) with one action; Atticus checks the format, stores it in the change, and the workflow carries on. Approval rules are unchanged: a manual step is still a step a person chose to do.

3. **Reads become imports.** Where Atticus would read from a system (work items to link to features, closed SNOW requests, PR states), the manual adapter reads exports instead: CSV or JSON exports dropped into `inputs/` and taken in by intake (ADR 0026). Suggestions made from them (for example, which ADO feature a detected feature belongs to) are triage items a person confirms, as with a live adapter.

4. **States the system can't report are asked.** A hand-off PR on an unreachable Git host is opened by a person from the prepared branch and description; its approval and merge are recorded back by that person (with the approvers' names), and separation of duties is checked on what is recorded.

5. **Same contracts, same records.** The manual adapter implements the same C4 interfaces as the live ones, so the change lifecycle, critic and planning code don't know which is in use; tests run the workflow end to end with the manual adapter as well as the mocks.

## Consequences

Atticus works on day one with no integrations at all, and each integration can be switched on later without changing the workflow. Manual steps are tracked, so nothing is lost; the cost is that the person must record results back, and Atticus can only check what is recorded. Overdue manual steps show on Home and in governance views.
