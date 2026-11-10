# An Apigee proxy to a vendor outside the estate, and the services that wrap it (invented)

Beta.24. Everything here is made up: Forge is an invented company, Northwind an invented vendor. An Apigee proxy bundle that is its own repo fronts Northwind, whose host is in no repo here; two Spring Boot services wrap Northwind's API (they serve the same paths themselves) and call it through the gateway, whose host the proxy's repo lists in the manifest.

| Repo | What it holds |
| --- | --- |
| `repos/northwind_wallets_1-0` | One proxy (`apiproxy/` at the root): base path `/northwind-wallets/1.0`, six conditional flows (`GET`/`PUT /accounts/*`, `POST /accounts/*/status`, `GET`/`POST /wallets`, `GET /wallets/*`), the target `TE-Northwind` whose `<URL>` is the build token `@targetNorthwindUrl@` (a commented-out URL above it), and the Apigee config plugin's `config.json`, which replaces that `<URL>` per environment (`test`, `prod`) with a Northwind host |
| `repos/forge-wallets` | Serves `/wallets`, `/wallets/{walletGuid}`; calls the proxy through a `@ConfigurationProperties` map: a host setting and a map of named paths in `application-forge-wallets-prod.yml`, and a live-looking client secret beside them |
| `repos/forge-accounts` | Serves `/accounts/{id}` and `/accounts/{id}/status`; calls the proxy through another layout: a base URL with the proxy's base path (`vendor.base-url`) and `vendor.paths.*` in `application.properties` |

`facts/` holds what a reader writes for each repo, as `/atticus-map` asks (verified against `repos/` in `packages/verify/test/gateway-vendor-proxy.test.ts`, `expected/verified.json`). `expected/join.yaml` and `expected/records.yaml` are the join and its records (`packages/core/test/facts-join-gateway-vendor.test.ts`), checked by hand: each service's call joins the proxy's flow of its method and whole path (by the gateway's host, verified), and the proxy's forwarding calls go to the host `config.json` gives (outside the estate), never back to the services that serve the same paths.

Files here are byte-exact: facts cite their line numbers.
