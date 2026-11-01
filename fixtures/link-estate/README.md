# Links on an estate shaped like a large bank's (invented)

Plan item P1. Everything here is made up: Forge is an invented company, and Northwind Pay and
Lantern Mail are invented vendors. Ten repos, read by hand into facts the way `/atticus-map`
asks, in the shapes a large bank's estate has:

| Repo | What it holds |
| --- | --- |
| `forge-portal-bff` | The portal's back end: calls the accounts and payments proxies on the gateway host `api.forge.example`, through the starter's `ForgeRestClient`. One of its calls (`GET .../payments/{id}`) is left out of the facts, a reading miss |
| `forge-proxy-accounts-v1`, `forge-proxy-payments-v1` | Internal Apigee proxies, each its own repo (`type: gateway`), all on `api.forge.example`, told apart by base path (ADR 0134); each forwards by `<URL>` to its service on the ingress host |
| `forge-proxy-northwind-v1` | An external proxy (`type: gateway-external`) on the same host, forwarding out to Northwind Pay |
| `forge-accounts`, `forge-payments`, `forge-cards`, `forge-notifications` | Spring Boot services behind one OpenShift ingress host, `apps.forge.internal`, each under `/forge-svc/<module>` (its Route's `path` in the deploy repo); their controllers write only `/accounts/{id}` and the like |
| `forge-starter` | The house starter library: `ForgeRestClient` (`forBase(url)`, `forService(id)`) makes every HTTP call, and its `TokenClient` fetches each service's token from Forge SSO |
| `forge-deploy-config` | The deploy repo: an OpenShift ConfigMap and Helm values that set the URLs (`NOTIFY_URL`, `ACCOUNTS_URL`, `FORGE_SSO_URL`) the services' `application.yml` leaves as `${PLACEHOLDERS}`, and each service's OpenShift Route (payments' a Helm template whose host is in its chart's `values.yaml`) |

`repos/` holds the source, `facts/` what a reader writes for each repo (verified against
`repos/` in `packages/scanner/test/measure-links.test.ts`), `org-pack/` the manifest and profile
(Harbor Audit and Forge SSO are other teams' systems no repo here belongs to, so outside the
estate), and `reference-links.yaml` the reference: each repo's entries and calls, each call with
the repo it should reach, the outside system, or none. It is written in the format a person
writes for their own estate (`atticus join measure`, docs/guide/measure.md).

## Where each repo is reached (plan item J1, ADR 0143)

`repos.manifest.yaml` lists only the gateway host `api.forge.example` on the proxies. The rest is
read: the deploy repo's Routes give each service's host and base path (`deploy` facts with
`host`, `basePath` and `exposes`, the templated one citing its values file), and each proxy's
`<BasePath>` its base path. The figures below are the same as when the manifest listed every
host and base path; with the exposure fields stripped they fall to precision 0.5 and recall 0.231.

## What the join makes of it today

The scorer (`measureLinks`, scanner) runs the estate join and compares. Pinned in the test:

- Through the gateway host and the ingress host: the portal's two calls reach the services
  through their proxies; each proxy's forwarding call reaches its service by base path; the
  payments service reaches notifications by its literal base URL, and the external proxy by the
  gateway; the proxy's forwarding call out to Northwind Pay is outside.
- Guesses: the cards service's relative call to `/accounts/{id}` joins by path, and the
  notifications service's cluster address (`accounts-api.forge-accounts.svc...`) by its first
  label; both right, both inferred. The accounts service's audit event, through the starter's
  service id `audit-gw`, joins notifications' own `POST /events` by path: inferred and wrong (it
  goes to Harbor Audit).
- Resolved through the deploy repo (plan item J0): the three calls whose base URL is a
  `${PLACEHOLDER}`. `${NOTIFY_URL}` and `${ACCOUNTS_URL}` are set for their services in
  `forge-deploy-config` and join notifications and accounts by host and base path, citing the
  placeholder's line and the value's; `${FORGE_SSO_URL}`, set for every service in the platform
  chart, gives Forge SSO's host, so the starter's token call is outside.
- Asked: payments' `/limits/{id}` (two services serve it).
- Missed: the cards service's `GET /ping` through the starter's service id: a path every service
  serves joins nobody.

Files here are byte-exact: facts cite their line numbers.
