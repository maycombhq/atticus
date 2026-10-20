# 0058. Dialect rules v3: lookups across files, structure, several records per match

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

Atticus is to read any ecosystem through rules an assistant drafts during onboarding (ADR 0055, 0056), not through a built-in reader per technology. Joining is already technology-neutral: merge joins any GatewayRoute, Endpoint or loose end, whoever emitted it. What limits a drafted dialect is what a rule can say. Writing dialects for three real gateway layouts showed the gaps:

- **Apigee with target servers.** A proxy's target names a server (`<Server name="payments-ts"/>`); the host is in an environment file elsewhere (`targetservers.json`). The base path is in another file of the same bundle. A rule sees one file.
- **Kong declarative config.** Routes sit inside services (`services[].routes[].paths[]`); a route's target is its service's `url`. A `jsonPath` match sees the matched node's own fields only, and a route with three paths is three routes.
- **Azure APIM (APIOps).** Each API's folder has an `apiInformation.json` with its path and backend URL: expressible today, which is the point of checking.

The same shapes recur outside gateways: a descriptor naming a service registered elsewhere, a Helm value pointing at a chart default, a pipeline template referencing a variable group.

## Decision

**Contract C2, additions** (optional, ADR 0041's rule; `schemaVersion` stays 1):

- **`lookups`** at the dialect level: named tables built from files with any match type, each row keyed by a template and holding named template values.

  ```yaml
  lookups:
    targetServers:
      match: { jsonPath: "$[*]", files: ["**/environments/*/targetservers.json"] }
      key: "${attr.name}"
      values: { host: "${attr.host}", port: "${attr.port}" }
  ```

  A template reads a row with `${lookup:<table>(<key expression>).<value>}`: `${lookup:targetServers(attr.Server).host}`. The key expression is any template value with filters: `${lookup:basepaths(file.path | parent | parent).path}`. A key with no row, or a key two rows give different values for, leaves the value unknown (so the field is unset, or the record skipped, ADR 0056).

- **`${node...}`**, the structure around a `jsonPath`, `xpath` or `hclBlock` match: `${node.key}` is the matched node's key (its element name for XML, its label for HCL), `${node.up.<field>}` a plain field of the nearest object (or element) above it, `${node.up.up.<field>}` the one above that, and `${node.up.key}` that object's own key. Arrays are stepped over. `$.services[*].routes[*].paths[*]` gives one match per path, with `${match.0}` the path and `${node.up.up.url}` the service's URL.

- **Filters** `parent` (a path without its last segment) and `basename` (its last segment).

- **`emit` may be a list**: one match gives each record in it (an Endpoint and the GatewayRoute in front of it, say). Each is rendered, checked and skipped on its own.

A lookup row's evidence is not added to the record; the record's evidence is the match. Lookups are read from the same repo only: no network, no other repos (rule 4).

## Consequences

- The three gateway layouts above are dialects, not code: Apigee with target servers and per-environment hosts, Kong with nested services and routes, APIM from its APIOps folders. Their dialects and tests are fixtures, and serve as the reference an assistant's draft is graded against.
- An assistant drafting a dialect for an unknown repo has the same means a person has; what it can't express, it says in its hand-over.
- Values not in any repo (a secrets vault, a config server) still need that source added to the estate or a person.
