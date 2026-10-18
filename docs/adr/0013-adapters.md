# 0013. Adapters for outside systems, each with a mock

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/adapters` defines one typed interface per kind of outside system, part of contract C4: work tracker (epics to tasks), service desk (requests), Git host (pull requests, reviews, checks), wiki and design tool (read-only), and notifications. The model provider belongs to the AI runtime (C5).

- **Approval on every write.** Every write method takes an `Approval` (who, when, what it approves). Adapters refuse a write without one. A standing approval, given once by a person, covers notifications only; everything else needs approval each time. This is a safety rule and isn't configurable.
- **Read-only where the plan says so.** Wikis and design tools have no write methods at all.
- **Merging is gated by the host's own rules.** A hand-off PR merges only when a required reviewer has approved (the latest review per person counts), nobody is requesting changes, it isn't a draft and every check passes. A protected branch can never be a PR's source.
- **One error type.** `AdapterError` carries a code (not-found, unauthorized, rate-limited, conflict, unavailable, invalid, not-approved) and whether retrying may help.
- **Mocks are first-class.** Each mock keeps a journal of every call and the approval behind it, can be told to fail the next call, and the work-tracker and service-desk mocks load the fixture's ticket exports. Tests never reach a network.
- **Wiring.** `createAdapters` builds what `runtime.yaml` configures. An unconfigured adapter is left out (shown as not connected); Atticus never falls back to a mock silently. Real adapters (Azure DevOps, ServiceNow, GitHub and others) register factories by type.

## Consequences

Every feature that touches an outside system is tested end to end against mocks, and real adapters can be added or swapped without touching the features that use them.
