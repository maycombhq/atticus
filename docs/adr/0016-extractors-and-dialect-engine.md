# 0016. Built-in extractors, loose ends and the dialect engine

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/extractors` holds the built-in extractors and the C2 dialect rule engine. All of them read files only (ADR 0007).

**Built-in extractors (first set):** component (one per code repo), OpenAPI 3.x and Swagger 2.0, Apigee-style proxy bundles, Spring (controllers; Feign, RestTemplate and WebClient calls; Kafka publish and listeners; SQL in JdbcTemplate calls and `@Query`; the datasource; resilience settings), frontend calls (fetch, axios, HttpClient), topic configs, SQL migrations (Flyway and plain DDL: tables, columns, keys, indexes) and infrastructure as code (Kubernetes Deployments, Terraform databases, alerts as YAML). They share small readers for Java, YAML and properties (with line numbers and `${…}` placeholder resolution), XML and SQL.

**Component names.** A repo builds one component, named by `component` in `repos.manifest.yaml`, else the repo id. This is an optional, additive field on the manifest (schema version unchanged). The scan passes the component, system and repo type to every extractor through `ScanContext`, and they are part of the cache key.

**Loose ends.** A call, publish, subscribe or database access whose other end isn't in the repo is emitted as an `Unresolved` record (C1, unchanged): `owner` is the component that holds it, and `unresolvedKind` and `raw` follow one grammar — `http-call` "METHOD URL", `event-publish` and `event-subscribe` "topic", `db-access` "read|write table", `db-connection` "URL". Merge (next ticket) resolves them into interfaces and table readers and writers; whatever can't be resolved stays in the catalog as an unresolved edge with an owner.

**Ids extractors produce.** Tables `<store>.<table>`, columns `<table>.<column>`, keys `<table>.pk`, `<table>.fk-<referenced table>`, indexes `<table>.<index>`, migrations `<store>.v<version>`, settings `<component>.<key without generic words>`, deployments `<component>.<env>`, alerts `<component>.alert.<name>`, topics `topic.<topic>`. REST endpoint ids are provisional; merge gives every endpoint its canonical id.

**Dialect engine.** A dialect file becomes an extractor named `dialect-<name>` with the dialect's version (so editing a dialect invalidates exactly its cache entries). It applies when the repo type or the manifest's dialect list names it and the marker file exists. Matches: annotations (with target), base classes, method calls (`${attr.arg0}`…), config keys with `*` wildcards, an XPath subset, a JSONPath subset and regular expressions. Rendering never half-fills a field; a record that fails C1 is reported, never kept. Interface ids are derived. `extends` merges parent rules (the child's wins); cycles and missing parents are errors. `runDialectTests` runs a dialect's own tests; a dialect whose tests fail must not load.

A small relaxation of C2's template checks: `${match.N}` is also available to config-key, XPath and JSONPath matches (N=0 is the matched value), and `${attr.*}` to XPath and JSONPath matches (the element's attributes or the object's fields).

## Consequences

The fixture's endpoints, gateway route, database design, settings, deployments and alerts come out of the extractors exactly as the expected catalog lists them; calls come out as loose ends ready for merge.
