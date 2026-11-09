# An Apigee proxy to the service it forwards to, by the path suffix (invented)

ADR 0124 addendum A-gateway. Everything here is made up: Forge is an invented company. Apigee sends a target its own path (the `<URL>` or `<Path>` after the host) with the request's path suffix after it (the part after the proxy's `<BasePath>`), unless the proxy sets `target.copy.pathsuffix` false; and each Spring Boot service serves its routes under a base path its entries leave out.

| Repo | What it holds |
| --- | --- |
| `repos/forge-billing-bff` | A back end calling the gateway at `GET /forge/fees/v1/retrieve` |
| `repos/forge-fees-proxy` | One proxy per repo (`apiproxy/` at the root): base path `/forge/fees/v1`, two conditional flows (`GET /retrieve`, `POST /quote`), target `<URL>@targetFeesUrl@/forge-fees/1.0/fees</URL>`, the token set in `config/prod.properties`. Its target call is recorded with the `<URL>`'s path only, and the retrieve flow has a forwarding call of its own with no host |
| `repos/forge-edge` | Three bundles: `forge-rates-v2`, a `<BasePath>/**` pass-through to `/forge-rates/2.0/rates`; `forge-limits-v3`, one flow to `/forge-limits/v3/limits`; `forge-refunds-v1`, one flow whose JavaScript policy sets `target.copy.pathsuffix` false, to `/forge-refunds/1.0/refunds` |
| `repos/forge-fees` | `/fees/retrieve`, `/fees/quote` and `/ping`, under `server.servlet.context-path=/forge-fees/1.0` |
| `repos/forge-rates` | `/rates/today`, `/rates/history/{date}` and `/admin/reload`; the manifest gives its `basePath: /forge-rates/2.0` |
| `repos/forge-limits` | `/limits/check`; nothing says its base path |
| `repos/forge-refunds` | `POST /refunds` and `POST /refunds/submit`, under an OpenShift Route's path `/forge-refunds/1.0` |

`facts/` holds what a reader writes for each repo, as `/atticus-map` asks (verified against `repos/` in `packages/verify/test/gateway-passthrough-suffix.test.ts`, `expected/verified.json`). `expected/join.yaml` and `expected/records.yaml` are the join and its records (`packages/core/test/facts-join-gateway-suffix.test.ts`), checked by hand: each fees flow lands on its entry under the context path, verified, and the BFF's call walks through to `GET /fees/retrieve`; the pass-through lands on the two `/rates/...` entries under the manifest's base path, not `/admin/reload`; the limits flow lands on `/limits/check` by its whole URL (`…/limits` and `/check` end in that one entry's path), verified, though nothing names its base path; a pass-through with no base path anywhere would be a guess (`joined-by-path-overlap`); the refunds flow lands on `POST /refunds` (the suffix kept off), under the Route's path, not on `/refunds/submit`.

Files here are byte-exact: facts cite their line numbers.
