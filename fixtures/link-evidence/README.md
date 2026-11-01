# Contract files and a traffic export as evidence for links (invented)

ADR 0151 (plan items J3 and J4). Everything here is made up: Forge is an invented company, and every
client id, IP address, user agent and token below is fake (the IPs are from the documentation
ranges). The estate is `fixtures/gateway-facts/`: the portal's back end (`forge-portal-api`) calls
the accounts service through the gateway's `forge-accounts-v1` proxy (base path `/forge/v1`).

| File | What it is |
| --- | --- |
| `forge-portal-api/pacts/forge-portal-api-forge-accounts.json` | A Pact v3 file (its example ids are kept as `{id}`): `GET /forge/v1/accounts/ACC-1001` (a link the join made: confirmed), `DELETE /forge/v1/accounts/ACC-1001` (no link) |
| `forge-portal-api/pacts/forge-portal-api-forge-ledger.json` | A Pact v4 file naming `forge-ledger` as provider of `POST /forge/v1/accounts/ACC-1001/transfers`, which the join links to the accounts service (the provider differs), and a message interaction (not a request: skipped) |
| `forge-portal-api/pacts/forge-portal-api-forge-billing.json` | A Pact v2 file naming `forge-billing`, a provider the estate doesn't have |
| `forge-portal-api/clients/accounts-openapi.yaml` | The accounts API's spec as the portal keeps it (`info.title: forge-accounts`): its `get` confirms the link |
| `traffic/apigee-analytics.csv` | An invented gateway analytics export with raw rows: client ids, IPs, user agents and tokens in query strings that must never be written |
| `traffic/apigee-analytics.json` | The same rows as a JSON array |
| `traffic/apigee-identifying.csv` | Rows whose app, proxy and path hold identifying values: compressed IPv6 addresses, a 36-letter token segment, a `;jsessionid=` matrix param, a person's name in a path and as an app, and an email with no top-level domain; none may be written |
| `forge-leaky-client/` | A consumer's contract files with a token in a Pact path's query, a long opaque segment with matrix params, a server URL with credentials and a query, and a Pact naming a provider the test's deny-list names |
| `expected/apigee-2026-09-01-2026-09-30.yaml` | The aggregate `atticus intake traffic traffic/apigee-analytics.csv --source apigee --from 2026-09-01 --to 2026-09-30` writes |
