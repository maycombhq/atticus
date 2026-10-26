# A UI's back end calling a service through an Apigee gateway (invented)

ADR 0124 addendum A-gateway. Everything here is made up: Forge is an invented company. Three repos, read by hand into facts the way `/atticus-map` asks:

| Repo | What it holds |
| --- | --- |
| `repos/forge-portal-api` | The portal's back end for its front end: a `RestClient` calling the gateway at `/forge/v1/...`, its base URL in `application.yml` |
| `repos/forge-gateway` | An Apigee proxy bundle `forge-accounts-v1` (base path `/forge/v1`, two conditional flows, a SpikeArrest, an OAuthV2 check on the transfer flow, an AssignMessage that rewrites the transfer's path), a shared flow `forge-security` (VerifyAPIKey) it calls through a FlowCallout, and the prod TargetServer `accounts-backend` |
| `repos/forge-accounts` | The accounts service, which serves `/accounts/{id}` and `/transfers` |

`facts/` holds what a reader writes for each repo (verified against `repos/` in `packages/verify/test/gateway.test.ts`); `expected/join.yaml` is the join, written by hand: the portal's `GET /forge/v1/accounts/{id}` lands on the service's `GET /accounts/{id}`, and its `POST /forge/v1/accounts/{id}/transfers` on `POST /transfers`, through the gateway's routes, with the auth a caller meets there.

This is a fixture of its own, not part of `fixtures/forge/repos/forge-gateway`: that bundle's catalog (`fixtures/forge/expected/scan.yaml`) is what the legacy readers' tests and many others compare against. Files here are byte-exact: facts cite their line numbers.
