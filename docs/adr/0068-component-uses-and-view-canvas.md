# 0068. What a module builds on, and the app's canvas draws the view itself

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

A repo with modules (ADR 0057) gives one component per module, but nothing said that `ledger-api` is built on `ledger-core`: a monolith's twenty modules drew as twenty unconnected dots, and a change to a shared module showed no reach. The app's Diagrams screen also drew the same component map for every view, so the Data view's table access (in the Mermaid text beside it) never showed on the canvas.

## Decision

**Contract C1, an addition** (optional, ADR 0041's rule): `Component.uses`, the components it builds on. The component extractor (1.1.0) fills it for a repo with modules: a module's pom `<dependencies>` (not `<dependencyManagement>`), matched by artifactId to another module's pom, and a package.json's dependencies, dev and peer dependencies, matched by name to another module's package.json. It is left out when there are none, so no existing record changes. The container view draws each as a `uses` edge between components of the system.

**Contract C4, an addition to the local API**: `GET /api/diagram/{view}/graph` gives a view's groups, nodes and edges (`atticus diagram render <view> --format json`); the sequence view has no canvas form. The Diagrams screen draws the chosen view with them: a layered layout, what calls or reads to the left of what it reaches, a group (a system, a data store) one box with its nodes in a grid, long columns wrapped, no box over another. Pointing at a box lights its edges.

Two reader fixes found on the same estate: a JPQL `@Query` names entities, so the Spring extractor (1.1.0) maps them to their tables (`@Table`, `@Entity(name)`, else Spring's naming); and an UPDATE after `DO` (PostgreSQL `ON CONFLICT`), `KEY` (MySQL `ON DUPLICATE KEY`) or `FOR` (a locking read) isn't a table.

## Consequences

- A multi-module repo draws as a connected system, and its build-time links are in the catalog with the build file as evidence.
- Not yet: Gradle `project(":x")` dependencies; `uses` across repos (a house library published from one repo and used by another is the framework model's job, ADR 0054); `uses` edges on the ecosystem map and in impact.
