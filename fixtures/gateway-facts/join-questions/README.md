# The estate join's questions, as question files (invented)

Beta.24 review. Everything here is made up: Forge is an invented company, Northwind an invented vendor. Four repos, read by hand into facts the way `/atticus-map` asks, each raising one of the questions the estate join asks:

| Repo | What it holds | What the join asks |
| --- | --- | --- |
| `repos/northwind_rates_1-0` | One Apigee proxy (`apiproxy/` at the root): base path `/northwind-rates/1.0`, one flow `GET /quotes/*`, the target `TE-Vendor` whose `<URL>` is the build token `@targetVendorUrl@`, and no `config.json` setting it | `unknown-host` on the token: a targets question in the join's words, saying to read the repo again (`forwardHostQuestion`) |
| `repos/forge-fx-v1`, `repos/forge-fx-v1-canary` | Two proxies on the same BasePath `/forge/fx/v1`, each with a flow `GET /rates` and no target | `ambiguous` for the teller's call: a targets question whose options are the two entries, each with its line |
| `repos/forge-teller` | A Spring client: `GET /forge/fx/v1/rates` through `fx.gateway-url`, a setting the platform's environment gives (`${FX_GATEWAY_URL}`), and `GET http://rates-cache:8080/cache/{key}`, an in-cluster name in no-one's domain | the ambiguous call above, and `unknown-host` on `rates-cache:8080`: a hosts question |

`reread/` is what a second read of `northwind_rates_1-0` records once the Apigee config plugin's `config.json` is in the repo: the token's value per environment (`test`, `prod`), so the join no longer asks about it and its open question retires.

The CLI tests (`packages/cli/test/join-questions-cli.test.ts`, `packages/cli/test/ui-api-join-questions.test.ts`) verify the repos, and pin the questions raised (once; Ignore offered), the next write honouring their answers (a vendor named, a candidate chosen, Ignore leaving the calls) and the token's question retiring.

Files here are byte-exact: facts cite their line numbers.
