# 0130. A vendor's operations, two versions compared, and what they reach

- Status: accepted (pending review by the product owner)
- Date: 2026-10-26
- Builds on: ADR 0017 (endpoint names), 0122 (knowledge files in the metarepo's inputs), 0124 (facts the assistant writes; addenda A-gateway, A-gateway2, B-change), 0125 (a Schema field says whether it is required)

## Context

An organisation calls a vendor's APIs through its own external gateway (an Apigee proxy). The vendor changes or adds operations; the proxy's routes, and the services that call through it, must change to absorb that.

Atticus already had most of the pieces:

- **Intake** takes partner specs dropped in `inputs/` (`atticus intake add`), deduplicates them by their bytes, and recognises a newer version of the same spec (the same title, or the same file name with the version or date taken out). The older one is marked `supersededBy` the newer.
- **The facts join** follows a call through gateways (A-gateway, A-gateway2). An external gateway's forwarding call is tied to the vendor's host by its TargetServer.

Two things were missing:

- Nothing compared two versions of a vendor's spec.
- Nothing traced a vendor operation back to the forwarding calls, and the service calls, that use it.

So a person reading a vendor's release notes had to find the affected routes and callers by hand.

## Decision

### 1. A vendor's operations, read from its spec

`readVendorSpec` (`packages/intake/src/vendor-ops.ts`) reads an OpenAPI 3 or Swagger 2 partner spec into the vendor's operations. For each operation it gives:

- the method and the path, with the server path in front where the spec names one (OpenAPI 3 `servers[0]`; Swagger 2's `basePath` is already in the path);
- the operationId;
- the auth and the scopes of its first security requirement;
- the request fields: query, header, cookie and form parameters, and the body's properties;
- the response fields: the properties of the first 2xx response.

Fields are read through `$ref` and `allOf`. Nested properties are dotted (`customer.email`), and an array's items go under `[]` (`items[].id`). Each field has its type, its enum values and whether it is required. Required follows ADR 0125's rule for OpenAPI: `true` when the object's `required` list names it, `false` for every other property of that object. A path parameter is left to the path.

Every operation cites the spec file and the line of its method. Every field cites the line of its property, and the line of the `required` list that names it.

There is one OpenAPI reader. The repo extractor's logic is factored out as `readOpenApiDocument` in `packages/extractors/src/openapi.ts`, and both read from it, so they agree on method, path, line, auth and scopes. The extractor's output is unchanged.

**In the catalog** (C1, no change to the schema). The current version of a partner spec gives:

- an `Endpoint` per operation, as before, with the same ids, served by the vendor's component (the system, when it has no components);
- a `Schema` per side with fields, named `<endpoint>.request` and `<endpoint>.response`, which ADR 0125 already names for an entry's Schemas;
  - format `openapi`;
  - `ref` a JSON pointer into the spec;
  - `version` the spec's version;
  - each field with its `type` and its `required`;
  - evidence citing the operation's line, then each field's line.
- The Endpoint's `schemaRefs` names its Schemas.

A partner spec is verified for what it says about its own system and nothing more. A superseded version gives no records: the catalog holds what the vendor says now.

**Linked to the vendor** as before: through the alias table, by the title or the file name. The spec's `servers` (OpenAPI 3) or `host` (Swagger 2) also give the vendor's hosts, so an external proxy's TargetServer host lands on the right vendor.

### 2. Forwarding calls matched to vendor operations

`joinVendorOperations` (`packages/core/src/facts-join-vendor.ts`) reads the facts. It is a separate file beside `facts-join.ts`, which it imports `routeScore` and `APIGEE_BUNDLE` from and does not change.

It considers every forwarding call of a gateway route. That is a `rest` call fact whose `from` is an entry of a repo the manifest types `gateway*`, or one cited in an Apigee bundle. For each one, it finds the vendor in this order:

1. a person's answer naming the vendor;
2. the call's `to`;
3. its host, or the hosts its base's config facts give (a TargetServer per environment).

A host is matched to a host the vendor's spec lists, else to the vendor's name written in a host label, as the merge already does (`api.northwindpay.example` is Northwind Pay).

When the hosts name two vendors, or none, the call is left to the estate join, which asks about it as before.

Then the operation. A candidate is an operation of the same method whose path, with or without the server path, has the call's shape. Path parameters are normalised, and a literal stands for a parameter at a lower score.

- **One candidate** is a match. The match keeps the route, the TargetServer that ties the call to the host, and the vendor operation's Endpoint id.
- **None** is a gap: "partner-gateway forwards PUT /v1/charges to Northwind Pay, whose spec publishes no such operation (it publishes POST on that path)".
- **Two or more equally good** is a question that lists both. This happens to a call that names no method.

The match is pure and deterministic.

### 3. Two versions compared

`diffVendorSpecs` (`packages/intake/src/vendor-diff.ts`) compares two versions with fixed rules. No model is called. Operations are paired by method and normalised full path. An unpaired operation whose operationId appears once on each side has **moved**; the rest are **removed** or **added**. For each pair it compares:

- the auth;
- the scopes;
- every request and response field: added, removed or renamed, required-ness, type, and enum values.

**Breaking or additive, from a caller's side:**

| Change                           | Breaking                                    | Additive                     |
| -------------------------------- | ------------------------------------------- | ---------------------------- |
| An operation                     | removed, or moved to another method or path | added                        |
| A request field                  | removed or renamed; added as required       | added as optional            |
| A response field                 | removed or renamed                          | added                        |
| A request field's required-ness  | made required                               | made optional                |
| A response field's required-ness | made optional                               | made always there            |
| A field's type                   | changed                                     | –                            |
| A request field's enum           | a value it no longer takes                  | a value it now takes         |
| A response field's enum          | a value it may now return                   | a value it no longer returns |
| Auth and scopes                  | auth changed; a scope the token now needs   | a scope it no longer needs   |

Two cases are never compared:

- A field whose required-ness is not stated (an unknown is not optional, ADR 0125).
- A field added or removed under a parent that was itself added or removed. The parent says it.

A **rename** is one field removed and one added in the same operation, side, place and parent, of the same type. Because it is a deterministic guess, it is said as a rename, so a person checks it.

Each change has:

- a stable id (`field-renamed.post-charges.request.reference`);
- the operation and its Endpoint id in each version;
- the field and side;
- `before` and `after`, each with its value and the spec line it cites;
- one plain sentence, for example "POST /charges/{chargeId}/refunds: the request field reason is now required; a caller that leaves it out is refused."

Changes are sorted with breaking first, then by path, method and kind.

### 4. The impact

`vendorImpact` (`packages/intake/src/vendor-impact.ts`) takes each change and works out what in the estate it reaches:

- **The forwarding calls.** For an operation that is gone or changed, these are the calls matched to the older version's operations, because that is what they call today. For an operation that was added, they are the calls matched to the newer version's.
- **The service calls** that go through each forwarding route. These are joins that land on the route, or that pass through it as a gateway hop. Each keeps its Interface, the routes it goes through, and the entry it is made under (its `from`). When the change is to a field, and the call's facts list the fields it sends or reads, the impact says whether it **sends** the field (with the line) or **doesn't send** it.
- **Further up the chain**, who calls that entry, and on up, breadth first. This is bounded at four entries (`MAX_UPSTREAM`). A gateway's own forwarding call is a hop of the joins through it, not a caller of its own.

The footprint is made from these:

- the repos;
- their systems, and the vendor's;
- today's flows that start at, or name, an affected entry;
- the Interfaces;
- the vendor Endpoints that change.

Gaps and questions against the older version are listed beside the footprint.

### 5. The command, and a change from it

**`atticus intake impact <spec> [--json]`** prints the comparison and the impact.

- `<spec>` can be either version, given as its `inputs/` path, a path on disk, its document id or its file name. It is compared with the version it replaces, or the one that replaces it.
- It prints the vendor and both versions, the counts, and each change. For each change it gives the change's sentence, the lines it cites, then the forwarding calls, the service calls and the callers upstream, each with its repo and `file:line`.
- Then it prints the affected repos and flows, and the `change new` line to start from them.
- `--json` gives `{ diff, impact }`.
- Exit codes:
  - 0: no breaking change reaches the estate;
  - 1: one does, or the spec can't be compared;
  - 2: no spec is named.

`intake` is outside the twelve top commands (ADR 0124 addendum D-cli), so this adds a subcommand. The top level stays at twelve. The surface census goes from 224 commands to 225.

**`atticus change new "<title>" --type <type> --impact <spec>`** starts a change whose footprint is the impact. It uses B-change's footprint and adds no new place for it:

- `systems`: the vendor's and the affected repos' systems;
- `touches.repos`: the affected repos;
- `touches.interfaces`: the affected Interfaces, `planned-modify`;
- `touches.records`: the affected flows and vendor Endpoints.

The impact is attached to the change as `inputs/<vendor>-<version>-impact.md` (ADR 0113), so every stage reads it as data. `changeFootprint` now reads a flow that `touches.records` names as a flow the change modifies, in the repo whose spec holds it. A stage that says otherwise still wins.

The words a person reads are in one place, `IMPACT_WORDS` in `packages/cli/src/vendor-impact-commands.ts`. The command, the change and the attached impact say the same thing.

## Contract notes

- **C1:** no schema change and no version bump. The records are kinds and fields C1 has: `Endpoint`, `Schema`, `required` (version 3, ADR 0125), `version` and `schemaRefs`. This wires ADR 0125's "OpenAPI `required`" rule for partner specs. The rule had been written but never wired. A metarepo whose partner specs have bodies gets new `Schema` records on its next intake.
- **The facts file** (ADR 0124): unchanged.
- **C4:** unchanged. `ScanInputsResult` is the same shape.
- **`ChangeTouches`:** unchanged. Its `records` already took "any other catalog record ids"; a Flow id there is now read as a flow.
- **`facts-join.ts`:** unchanged. The vendor match is its own function, in its own file.

## Feeding a vendor's specs

Add each version beside the last, never over it: `atticus intake add northwind-pay-openapi-v2.yaml`.

- Intake keeps both, reads the newer one into the catalog, and marks the older one superseded.
- Writing a new version over the old file leaves nothing to compare.
- The same title (`info.title`) is what makes two files versions of one spec. Failing that, it is the same file name once the version or date is taken out.
- When nothing says which version is newer, triage asks.

## Consequences

- A vendor's release becomes a list of changes, each cited in both versions, with what it reaches in the estate, also cited. A change can start from that list with its footprint already filled in.
- No model is called, and the result is deterministic.
- The catalog gains request and response Schemas for every partner spec with bodies.

**Not done here:**

- **Not in the catalog.**
  - A matched forwarding call isn't projected into an `Interface.endpoint` naming the vendor operation. The Interface stays as the merge makes it.
  - A gap or an ambiguous match is printed, not raised as an ADR 0078 question.
- **Calls the match doesn't read.** It reads only gateways' forwarding calls. A service that calls the vendor directly isn't matched to an operation, though its call still joins the vendor as before.
- **What the diff doesn't compare.**
  - AsyncAPI specs.
  - `oneOf` and `anyOf`.
  - Error responses and status codes.
  - Headers on responses.
  - A field renamed and retyped at once, which reads as one removed and one added.
- **No screen in the app.**
