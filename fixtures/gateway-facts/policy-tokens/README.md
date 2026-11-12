# An Apigee proxy whose target URL config.json sets by the token's name (invented)

Beta.27, from a user's estate re-made with invented names: Forge is an invented company, Northwind Pay an invented vendor. An Apigee proxy that is its own repo fronts Northwind Pay; its TargetEndpoint's `<URL>` is the deploy token `@targetVendorUrl@`, which the deploy's `config.json` sets per environment by the token's name (`configurations[].policies[]` of `{ "name": "@targetVendorUrl@", "value": "<URL>" }`, not the Apigee config plugin's XPath `tokens`). Two of the estate's services serve the same paths as the vendor does; a third calls the proxy through the gateway's host.

| Repo | What it holds |
| --- | --- |
| `repos/northwind_pay_1-0` | One proxy (`apiproxy/` at the root): base path `/northwind-pay/1.0`, four conditional flows (`GET /payments/*`, `POST /payments`, `POST /refunds`, `GET /refunds/*`), all routed to `TE-Vendor`, whose `<URL>` is `@targetVendorUrl@`; `config.json` sets it for `dv`, `qa` and `prod` |
| `repos/forge-payments` | Serves `GET /payments/{id}` and `POST /payments` |
| `repos/forge-refunds` | Serves `POST /refunds` and `GET /refunds/{id}` |
| `repos/forge-checkout` | Calls `GET /northwind-pay/1.0/payments/{id}` and `/refunds/{id}` on the gateway host `gw.forge.example` |

The profile (`org-pack/profiles/forge/profile.yaml`) lists Northwind Pay as a vendor system with `api.northwind-pay.example` and `devapi.northwind-pay.example` as its aliases.

`facts/` holds what a reader writes for each repo, as `/atticus-map` asks (verified in `packages/verify/test/gateway-policy-tokens.test.ts`, `expected/verified.json`). The joins, checked by hand (`packages/core/test/facts-join-gateway-policy-tokens.test.ts`):

- `expected/join.yaml`, `expected/records.yaml`: the proxy's forwarding calls leave the estate for the vendor's hosts, never to the services by their path; the checkout's calls join the proxy's flows by the gateway's host.
- `expected/join-no-forward.yaml`: one route's forwarding call left out (a person said it isn't a call), another's never read: those routes join nothing; the checkout's call to one ends at the route.

`expected/catalog-path-guess.yaml` is the catalog an earlier read's path guess gave (`packages/cli/test/policy-tokens-cli.test.ts`): each arrow inferred, flagged `joined-by-path`, with its caller's line; the test then shows the arrows go once the proxy is read again, whether the build drew them or a beta.26 catalog was adopted with them.

Files here are byte-exact: facts cite their line numbers.
