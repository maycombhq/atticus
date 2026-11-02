# term-notes (ADR 0163)

An invented Forge estate for org notes and term facts. Three Apigee proxy repos keep the
applications let in to their API in an access-list file, each in its own shape: a JSON array of
objects (`forge-accounts-proxy/userAccess.json`), a nested JSON object
(`forge-cards-proxy/userAccess.json`) and YAML (`forge-limits-proxy/userAccess.yaml`). Each entry
names a consumer by its CMDB id (`APP000123`). Three services name their own CMDB id in
`forge-app.yaml`.

- `org-pack/repo-types/forge-apigee-proxy/type.yaml` has notes saying what `cmdb` means there and
  one that reads as a rule (every call to a vendor uses mTLS and auth).
- `org-pack/repo-types/forge-spring-service/type.yaml` is a version-1 file with no notes: it must
  still parse.
- `org-pack/conventions.yaml` holds an org-wide note.
- `facts/` holds each repo's facts, every one verified against `repos/`.

`forge-payments` (APP000123) is a listed consumer of the accounts and cards proxies and calls the
accounts proxy; `forge-statements` (APP000999) calls the accounts proxy and is listed by none;
`forge-ledger` (APP000456) is listed by the accounts proxy and calls nothing. `forge-payments`
calls Northwind Pay with mTLS and a token; `forge-statements` calls Tidewater with neither.
