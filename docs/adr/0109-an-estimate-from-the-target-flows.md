# 0109. An estimate from the target flows: ranges with their drivers, never a made-up number (C6, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0045 (release views; the forecast from dates alone), 0087 (flow deltas), 0095 (target flows beside today's), 0108 (a change drawn from its target flows)

## Context

People ask how big a change is and when it can ship. The release forecast answers the second from dates alone: the service requests' lead times along the deployment plan. Nothing answers the first. An AI asked for a number gives one, and nobody can say where it came from. The target flows already say exactly what a change adds, changes and removes, step by step.

## Decision

An estimate is worked out from the target flows, without AI:

1. **Size.** Each step a target flow adds, changes or removes is a unit of work, classed by its op and kind and what it reaches: `add/call-out/vendor/new-entry`, `change/write/migration`, `add/lookup/new-table`. A new flow is one more unit (`new-flow/<trigger>`), a removed flow one unit (`remove-flow`). Every unit cites its target-flow file and step.
2. **Effort per class** comes from a new org-pack file, `estimates.yaml` (C6, schemaVersion 1): per class (or a class's first segments then `*`), a range in ideal developer days, p20, p50 and p80, and who agreed the figures (`source`, required). The first class that matches wins. `perExtraRepo` adds the cost of each repo past the first. `risks` sets how much a risk widens the upper end. A unit no class matches gets no number: the estimate says it needs a class.
3. **Summed by a seeded simulation**: each range a log-normal through its p50, as wide as its p20 to p80, 4,000 draws, seeded by the change's id, so the same change always gets the same range.
4. **Drivers**, each with a count and its source: new calls to a vendor, new tables, migrations, changed steps no check or person confirmed, open blocking findings, open questions, other open changes on the same parts, repos to change. A risk's factor from the org pack widens p80 only; the middle moves only when calibration shows it should.
5. **Calendar**: the later of the work (p80) and the waiting the release forecast found, and which one is longer.
6. **Calibration**: until past changes record their effort, the estimate says it isn't calibrated, and whose figures it uses. Recording effort when a task closes, and checking how often changes land inside their range, is the next step.

Without `estimates.yaml` the estimate sizes the work and gives no days.

`atticus change estimate <change> [--json]`, the local API's `GET /api/changes/{changeId}/estimate`, the app's Estimate screen, the plugins and the `change_estimate` MCP tool show it.

## Consequences

- An estimate is reproducible, cites every unit, and says what drives it and whose figures it rests on.
- It is only as good as the target flows and the org pack's ranges; both are reviewed files.
- The new org-pack file is optional, so no pack needs a migration.
