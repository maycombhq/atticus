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

5. **How to do each step is learned from the organisation's own knowledge, not hand-written.** What a manual step asks for (which request type, which fields, which assignment or approval group, typical lead time, the ADO work item template and process) comes from the org pack's templates (`process/snow/*.yaml`, story and task templates), and those templates are drafted from what the organisation already has: how-to pages in its wikis (knowledge sources, ADR 0021), documents uploaded to intake (ADR 0026), and exports of past tickets (closed SNOW requests, ADO items). Structured parts are read deterministically (a field list on a how-to page, the columns and values of past tickets: which fields were always filled, which approval group always approved, the median time from open to close); free text is read by an AI agent outside any scan. The result is a draft template with every value citing its source page or tickets, proposed as an org-pack change for a person to review; it is used only once approved, and later evidence that disagrees (a new field on the wiki page, a different approval group in recent tickets) becomes a triage item to update it. On the Forge fixture, `inputs/wiki/snow-firewall-request.md` and `inputs/tickets/closed-service-requests.json` must yield the firewall-rule template the fixture's org pack holds (fields, approvers, a 10-day lead time).

6. **Same contracts, same records.** The manual adapter implements the same C4 interfaces as the live ones, so the change lifecycle, critic and planning code don't know which is in use; tests run the workflow end to end with the manual adapter as well as the mocks.

## Consequences

Atticus works on day one with no integrations at all, and each integration can be switched on later without changing the workflow. Manual steps are tracked, so nothing is lost; the cost is that the person must record results back, and Atticus can only check what is recorded. Overdue manual steps show on Home and in governance views.
