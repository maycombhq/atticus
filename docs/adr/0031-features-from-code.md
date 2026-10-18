# 0031. Features found in code, with gaps, people's names and links to work items

- Status: accepted (direction from the product owner, 2026-10-18); built in M3, right after the critic
- Date: 2026-10-18

## Context

The catalog knows the parts of an estate and how they connect across repos (systems, components, endpoints, interfaces, events, tables) but not the features they add up to. Brownfield estates have no living spec on day one, many features are known only to the people who built them, and work items in the tracker (ADO epics, features, stories) are not linked to the code that implements them.

## Decision

1. **A new C1 kind, `Capability` (shown as "Feature").** Fields: name, description, status, entry points, the records it spans (components, endpoints, interfaces, topics, tables), owner, tags, external references (work items such as ADO epics and features, wiki pages, OpenSpec capability specs), how it was named (`detected`, `ai`, `person`) and the usual confidence and evidence. This is a C1 change: catalog schema version 2 with a migration (version-1 files are rewritten unchanged except `schemaVersion`; readers accept both until the migration runs).

2. **Detection without AI, in every scan.** From each entry point (a UI route, a public or gateway endpoint, a scheduled job, an event consumer that starts work) Atticus traces the flow across repos through interfaces, events and table access, and groups flows into candidate features using signals in the code: OpenAPI tags and operation ids, controller, package and module names, UI route names, shared tables and topics. Candidates get a stable id from their entry points and a provisional name from those signals, `named_by: detected`, confidence `inferred`.

3. **Naming with AI, outside the scan.** An agent proposes a name, a one-paragraph description and tags for each candidate from its evidence (C5 runtime; replay in tests). The proposal stays `inferred` until a person confirms it.

4. **People name, tag, merge, split and link.** A developer or owner confirms or corrects a feature with `atticus feature name|tag|merge|split|link` (and later in the UI). Each answer is saved as a `CuratedDecision` (assert, classify, alias) in `catalog/curated/`, applied on every scan (ADR 0026), so the knowledge survives rescans and is reviewable in Git. A confirmed feature is `asserted`, and can seed an OpenSpec capability spec so the as-is specification starts from real code.

5. **Links to work items.** Through the work-tracker adapter (read only; ADO first), Atticus suggests links between features and existing epics and features by name, tags and the repos and paths that the items' linked PRs touched. Suggestions are triage items; a person confirms each link, which is saved as a curated decision. Nothing is written to the tracker without approval.

6. **Knowledge gaps about features.** The knowledge checks (ADR 0021) gain feature checks, each raising an owner question to the feature's or system's owner: a flow that ends in a loose end (unknown caller or callee); a feature with no name or owner confirmed; no work item linked; no tests found for its entry points; no alerts or dashboards for it; a feature only documents describe, or only code. Coverage reports features as confirmed, detected only, or unknown.

## Consequences

The catalog answers "what features do we have, where is each implemented, who owns it, which work items built it, and what don't we know". The critic and impact can say which feature a change touches. Costs: a C1 schema version bump with a migration, the flow tracer, and the naming agent's evals.
