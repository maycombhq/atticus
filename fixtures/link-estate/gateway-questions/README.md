# Questions a gateway proxy and its callers raise (invented)

Beta.12. Everything here is made up: Forge is an invented company, Northwind Pay an invented
vendor. Four repos, read by hand into facts the way `/atticus-map` asks:

| Repo | What it holds |
| --- | --- |
| `forge-proxy-core-v1` | An Apigee proxy that is its own repo (`type: gateway`), BasePath `/forge/core/v1`, with five flows under two prefixes (`/accounts/*`, `/accounts/*/status`, `/cards/*/pin`), every route forwarding through one TargetServer, `core-backend` (its host in `edge/env/prod/targetservers.json`, no scheme) |
| `forge-ledger-core` | A Spring service serving the `/accounts/**` routes and `POST /postings` |
| `forge-card-vault` | A Spring service serving `/cards/{id}/pin` |
| `forge-teller-app` | A client: `config.getUri("money-posting")` and `config.getUri("core-gateway")` through a house remote config (no value in the repo), and one literal URL on the shared gateway host `api.forge.example`, which no repo lists |

`questions/` holds the target questions as they were written on 2026-10-28, before beta.11: one
per call, each option listing a repo read then (the ledger wasn't), worded "<repo>, built in
<repo>, answers <call>". One of them (`GET /cards/{id}/pin`) is answered. The CLI test
(`packages/cli/test/gateway-questions-cli.test.ts`) reads them, verifies the repos, and pins what
beta.12 makes of them: the open ones refreshed in place or retired into one question per path
prefix, the answered one untouched, and the rule offered when several share a prefix.

Files here are byte-exact: facts cite their line numbers.
