# 0035. Universal by design

- Status: accepted (direction from the product owner, 2026-10-18)
- Date: 2026-10-18

## Context

OpenSpec was not designed around one company's systems: its specification format holds any system. Atticus must be the same. The first client is a bank with Java services, an API gateway, ServiceNow and ADO, and nothing in Atticus may be shaped by that. The client's specifics belong only in its org pack, dialects and plugins (rule 7 of CLAUDE.md), and the product is complete before any client install (decision 16).

## Decision

1. **The catalog is a published, product-neutral specification.** Contracts C1 (records), C2 (dialects), C3 (rules and findings), C4 (plugins, adapters, executors, local API), C5 (AI runtime) and C6 (org pack) are documented as a standalone specification under `docs/spec/`, generated from the zod schemas plus prose, versioned, with a conformance suite any implementation or plugin can run. Nothing in it names a vendor, industry or company; vendors appear only as adapter types and examples.

2. **A vocabulary review before 1.0.** C1 must describe any ecosystem without stretching fields. Gaps already known and to be closed with an ADR and the schema version 2 migration (ADR 0031) or a later minor version: endpoint types for GraphQL, WebSocket and server-sent events, webhooks, serverless functions and scheduled functions, and online transactions (mainframe CICS); `via` values for service mesh and webhooks; mobile and desktop apps, data pipelines (orchestrators, transformation jobs), ML models and feature stores, SaaS products used as systems, file transfers and shared storage as first-class data movement; schedules as a setting kind; ingress routes. Each addition comes with an extractor or dialect that produces it and a golden test.

3. **A second, deliberately different reference ecosystem.** Next to Forge (a Java- and gateway-heavy bank), a second invented ecosystem, **Harbor** (an online retailer: Node, Python and Go services, GraphQL and gRPC, a service mesh on Kubernetes in a public cloud, serverless functions, a mobile app, a data pipeline and a warehouse, Jira and GitHub, SaaS vendors such as an invented payments and an invented email provider), with its own hand-written expected catalog, diagrams, documents and seeded discrepancies. Every stage exit that is measured on Forge is also measured on Harbor before 1.0, so nothing passes only because it fits one shape.

4. **No ecosystem-specific code in the core.** A review rule: core packages never branch on a framework, vendor, company or industry name; such knowledge lives in extractors, dialects, adapters and org-pack data. The deny-list check (no client data) stays; a new lint flags vendor names in core packages outside adapter and extractor folders.

## Consequences

Atticus can be adopted by any organisation and evaluated by anyone against a published spec; the first client gets a product proven on two unlike ecosystems rather than one tuned to it. Costs: the spec documentation and conformance suite, the vocabulary additions, and the Harbor fixture with its golden files (scheduled across M3 to M5).
