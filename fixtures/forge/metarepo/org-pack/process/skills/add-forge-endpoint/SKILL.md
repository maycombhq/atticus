---
id: add-forge-endpoint
name: Add an endpoint to a Forge service
description: How to add a REST endpoint to a service built on the Forge framework, with its OpenAPI entry and tests.
appliesTo:
  repoTypes: [forge-service]
  artifacts: [tasks]
owner: team-ledger
source: inputs/wiki/ledger-solution-spec.md
status: active
reviewedAt: 2026-10-01
---

1. Add a method annotated `@ForgeEndpoint(method, path, auth)` to the service's endpoints class.
2. Add the operation to `api/<service>-openapi.yaml` with the same method and path.
3. Write a test that calls the endpoint and checks the response and the error cases.
4. If the endpoint is public, raise a gateway route request (process/snow/gateway-route).
