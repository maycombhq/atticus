# A proxy whose target URL's host is a token nothing sets, in front of a service no System names (invented)

Beta.28.1, from a user's estate re-made with invented names: Forge is an invented company. An Apigee proxy that is its own repo forwards four REST routes to a Spring Boot service. The proxy's TargetEndpoint `<URL>` is `@forgeTargetUrl@/forge-instruments/1.0/instruments`: the host is a deploy token that no file of the estate sets (no `config.json`, no setting of that name), the path after it is written out. The service serves its routes under two Spring path variables with a regex (`/{moduleName:.+}/{moduleApiVersion:.+}/instruments/...`), and is listed in the manifest only: no System of the profile names it, so the catalog draws it in a system of its own id.

| Repo | What it holds |
| --- | --- |
| `repos/forge_instruments_1-0` | One proxy (`apiproxy/` at the root): base path `/forge/instruments/v1`, four conditional flows (`GET /ping`, `POST /`, `GET /*`, `POST /*/status`), all routed to `TE-Instruments`, whose `<URL>` is `@forgeTargetUrl@/forge-instruments/1.0/instruments` |
| `repos/forge-instruments` | `InstrumentsController` under `@RequestMapping("/{moduleName:.+}/{moduleApiVersion:.+}/instruments")`: `GET /ping`, `POST`, `GET /{instrumentId}`, `POST /{instrumentId}/status` |

`facts/` holds what a reader writes for each repo, as `/atticus-map` asks: each route an entry, each route's forwarding call with `host` the `<URL>` as written and `path` the URL's path and the route's suffix, cited on the `<Condition>` with the `<URL>` line in `cite.with`.

What the join and the app must do with it (`packages/core/test/token-host-connect.test.ts`, `packages/cli/test/ui-api-links-token-host.test.ts`, `packages/ui/test/connect.test.tsx`, `packages/ui/test/edit-map.test.tsx`, `packages/ui/test/declare.test.tsx`):

- The join asks which repo answers on the token (`unknown-host`) for each forwarding call: no path guess, no outside placement, no arrow.
- Connect to… from the proxy's box lists the four calls loose, with the service's entry each most likely is by its path's tail (the Spring variables in front are any segment), picked only where one entry is well ahead.
- Paired from the canvas, each call joins the service "by a person" once `verify --write` reads the pairings: an arrow from the proxy to the service, with no System written first.

Files here are byte-exact: facts cite their line numbers.
