# 0021. Knowledge sources, pattern scan, coverage and owner questions

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/knowledge` reads wikis through read-only adapters: a folder adapter for markdown folders, exports and Git-clone wikis, and the C4 wiki adapter for API wikis (mocked in tests). Folder locations in `sources.yaml` are relative to the org-pack folder. Atticus never writes back to a wiki, and `atticus sources add` only prints the `sources.yaml` entry: the org pack changes through a reviewed PR.

**Facts from wiki text** come from fixed, deterministic patterns: owner lines, calls through the gateway or direct, data read through an API, SLOs and peak load. Names are resolved the same way as on diagrams (ADR 0019). Code wins: a contradiction becomes a document conflict for triage. A fact only a document gives becomes a proposed `inferred` record (for example an Obligation) that waits for its owner, never an `asserted` one. Pages above the classification limit are skipped and leave only their path. A page is stale by age (the pack's freshness window, default 365 days) or when code for a system it describes was seen after the page's date; a page with no date is "unknown", not stale.

**Pattern scan** reads the integration-pattern page into draft C6 patterns and diffs them with the org pack: new, changed, missing, same.

**Knowledge gaps.** Each knowledge check declares the facts it `needs`. A missing or stale needed fact for a system becomes a knowledge gap with an `OwnerQuestion` to the system owner, falling back to the platform owner and then the architect (`flags: [route:architect]`). An answered question doesn't close the gap until the fact is in the catalog. The first checks: call resilience known for vendor calls, unattended workloads (batch jobs, event consumers) monitored, and a component's source known.

**Coverage** counts seven areas per system (interfaces, data, runtime, observability, access, quality, obligations) as verified, document-only or unknown; document-only never counts as known. It is the API's `getCoverage`.

**Commands:** `atticus sources add|sync`, `atticus patterns scan`, `atticus coverage`, `atticus questions`.

Contract notes (no change made): C6 has classification levels but no limit, so the limit is a parameter defaulting to `internal`; `OwnerQuestion.questionState` has no draft state, so a new question starts as `sent`, although sending still needs an approved adapter write; `overdue` can't be computed without a sent date. Candidate additive fields for a later ADR: `pack.yaml maxClassification`, `OwnerQuestion.sentAt`.

## Consequences

On Forge it finds d12 (both document conflicts) and d09–d11 (the owner questions) exactly, and the pattern scan matches the org pack.
