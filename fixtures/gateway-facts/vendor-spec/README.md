# A gateway's routes landed on a vendor's spec operations (invented)

Beta.27, from a user's Outside systems page re-made with invented names: Forge is an invented company, Northwind Pay an invented vendor. An Apigee proxy that is its own repo fronts Northwind Pay. Its routes forward the path suffix to the TargetEndpoint `northwind-pay-target`, whose `<URL>` is the deploy token `@targetVendorUrl@`; the deploy's `config.json` sets it per environment by the token's name to `https://devapi.northwind-pay.example/api/v1` (`dv`) and `https://api.northwind-pay.example/api/v1` (`prod`). The vendor's spec, `inputs/inbox/northwind-pay-openapi.yaml`, publishes its operations as `/api/{version}/...` on the host root.

| Repo | What it holds |
| --- | --- |
| `repos/northwind_accounts_1-0` | One proxy: base path `/northwind-accounts/1.0`, five conditional flows (`POST /account_instruments`, `GET /accounts/balances`, `GET /accounts/*`, `GET /cards/*/pin`, `GET /bulkorders`), each forwarding to `@targetVendorUrl@` |
| `repos/forge-onboarding` | Calls `POST /account_instruments` through the setting `northwind-pay.base-url: ${gateway-url}/northwind-accounts/1.0`, `gateway-url` being the gateway's host `gw.forge.example` |

The profile lists Northwind Pay as a vendor with `api.northwind-pay.example` and `devapi.northwind-pay.example` as its aliases.

What each forwarding call reaches, checked by hand (`expected/vendor-join.yaml`, `packages/core/test/facts-join-vendor-spec.test.ts`): the vendor's path is the target URL's `/api/v1` and the route's suffix, a path parameter takes any one segment, and a literal is preferred over a parameter.

- `POST /account_instruments` reaches `POST /api/{version}/account_instruments`.
- `GET /accounts/balances` reaches `GET /api/{version}/accounts/balances`, not `/accounts/{account_guid}`.
- `GET /accounts/*` is a wildcard route: it reaches both `/accounts/{account_guid}` and `/accounts/balances`.
- `GET /cards/*/pin` reaches `GET /api/{version}/cards/{card_guid}/pin`.
- `GET /bulkorders` reaches nothing the spec publishes: the one call under "Calls that match nothing in its spec".
- The onboarding service's call joins the proxy's `POST /account_instruments` route by the gateway's host and base path, and reaches the vendor through it. Beta.26 took it for a direct call to the vendor, reading the setting's name `northwind-pay.base-url` as a host whose first label is the vendor's name.

`expected/outside-callers.yaml` is the vendor's callers on the Outside systems page (`packages/cli/test/vendor-spec-cli.test.ts`), after `atticus verify <repo> --write` of both repos: each call with the operations it reaches, the onboarding service behind the proxy's route.

**The per-environment case** (`expected/vendor-join-per-env.yaml`, the review of beta.27). The tests rewrite the two settings (in `config.json` and the facts alike, same lines) so both environments use one host with different paths: `https://api.northwind-pay.example/api/v1` (`dv`) and `https://api.northwind-pay.example/api/v2` (`prod`). Each environment's path is matched on its own: every call reaches the same operation in both (the spec's `{version}` takes `v1` and `v2`), the match and the Map's arrow carry prod's path (`/api/v2/...`, the prod-like environment's), each match names `env: prod`, and the one gap says both paths: `GET /api/v2/bulkorders in prod (/api/v1/bulkorders in dv)`. With the spec publishing each version's balances as its own operation, the call reaches both, one per environment, never a question.

Files here are byte-exact: facts cite their line numbers.
