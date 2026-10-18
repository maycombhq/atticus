# 0025. ORM, observability, AsyncAPI and mainframe extractors; shipped dialects

- Status: accepted
- Date: 2026-10-18

## Decision

Atticus reads the database design from ORM mappings (JPA, EF Core, SQLAlchemy, Prisma), observability kept as code (Prometheus rules, Grafana and Datadog, OpenTelemetry, logging config, runbooks), AsyncAPI 2 and 3 documents, and basic mainframe sources (JCL, COBOL copybooks, CICS CSD text), all deterministically. ORM records reuse the migrations extractor's store naming and ids, so a table seen in a mapping and a migration merges into one record; mapping facts are `inferred` and migration values win (merge keeps the first value and the strongest confidence, and `migrations` sorts before `orm`). AsyncAPI 2 operations are written from the client's view and are turned round. CICS transactions become Settings because C1 has no endpoint type for them.

Atticus ships three C2 dialects (`jaxrs`, `micronaut`, `quarkus-reactive-messaging`) that repos opt into through `dialects:` in the manifest. The scanner loads them as defaults, runs their tests like any dialect, and an org-pack dialect with the same name replaces a shipped one.

## Consequences

More of an estate is catalogued without house dialects. Where C2 falls short the shipped dialects use regex rules, which are harder to read; candidate additive C2 features: `${repo.component}`, access to a matched member's other annotations, config lookups keyed by a matched value. Candidate C1 additions: an endpoint type for online transactions and a `cobol-copybook` schema format.
