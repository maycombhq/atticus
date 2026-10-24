# Security review draft: Add a daily transfer limit

Change `add-transfer-limit`, generated 2026-10-21 from the catalog and the change folder. A draft for the reviewers of the hand-off PRs: every line says where it came from, and anything Atticus couldn't find is listed as a gap.

## New or changed interfaces

| Operation | Caller → callee | Change | Auth | Auth from | Crosses | Source |
| --- | --- | --- | --- | --- | --- | --- |
| POST /transfers | portal-bff → ledger-api | modify | oauth2 | catalog Interface if-d99f508a2ac9b6e0 | Portal → Ledger (product) | interfaces.md:5 |
| GET /accounts/{id}/limit | portal-bff → ledger-api | new | oauth2 | catalog GatewayRoute gw-ledger-v1 policy VerifyOAuth | Portal → Ledger (product) | interfaces.md:6 |
| POST /v2/velocity-checks | ledger-api → northwind-pay | new | mtls | interfaces.md:15 | Ledger → Northwind Pay (vendor) | interfaces.md:7 |
| POST /audit/events | portal-bff → audit-svc | modify | not stated | nowhere | Portal → Audit (internal) | interfaces.md:8 |
| POST /risk/assess | ledger-api → risk-engine | new | not stated | nowhere | risk-engine isn't in the catalog | interfaces.md:9 |

## Data fields touched

Classification levels (org pack): public, internal, confidential, restricted.

| Field | Classification | From | Personal data | Source |
| --- | --- | --- | --- | --- |
| ledger-db.account.daily_limit | internal | data.md:12 | no | data.md:7 |
| ledger-db.limit_change.id | internal | data.md:13 | no | data.md:8 |
| ledger-db.limit_change.account_id | internal | data.md:13 | no | data.md:8 |
| ledger-db.limit_change.old_limit | internal | data.md:13 | no | data.md:8 |
| ledger-db.limit_change.new_limit | internal | data.md:13 | no | data.md:8 |
| ledger-db.limit_change.changed_by_email | internal | data.md:13 | yes | data.md:8 |
| ledger-db.limit_change.changed_at | internal | data.md:13 | no | data.md:8 |

## Data crossing a boundary

### POST /transfers: Portal → Ledger (product)

No mapping change. The response gains error LIMIT_EXCEEDED (HTTP 422) with the remaining limit. (mappings.md:3)

### GET /accounts/{id}/limit: Portal → Ledger (product)

| Field | Classification | Transformation | Sensitive | Source |
| --- | --- | --- | --- | --- |
| account.daily_limit | internal | as is | no | mappings.md:11 |
| sum of today's outgoing entries | not a catalog field | limit minus the sum, never below 0 | unknown | mappings.md:12 |

### POST /v2/velocity-checks: Ledger → Northwind Pay (vendor)

| Field | Classification | Transformation | Sensitive | Source |
| --- | --- | --- | --- | --- |
| account.account_number | not classified yet | hashed with the shared key | yes | mappings.md:18 |
| transfer amount | not a catalog field | as is, two decimals | unknown | mappings.md:19 |

### POST /audit/events: Portal → Audit (internal)

| Field | Classification | Transformation | Sensitive | Source |
| --- | --- | --- | --- | --- |
| account id | not a catalog field | as is | unknown | mappings.md:25 |
| "limit-refused" | not a catalog field | constant | unknown | mappings.md:26 |

## Vendors

- Northwind Pay (northwind-pay): already called (1 interface in the catalog); new or changed: POST /v2/velocity-checks.

## Secrets and settings touched

- OAuth client portal-bff with scopes ledger.read, ledger.write (existing grant) (catalog AccessGrant gw-ledger-v1.oauth-scopes)
- A client certificate for ledger-api to call POST /v2/velocity-checks (mTLS) (interfaces.md:15)
- account.account_number → accountRef: hashed with the shared key; refuse the transfer (mappings.md:18)

_Not judged: 1 line of the change wasn't read for secrets (no model was asked, or a judge couldn't tell), so a person reads it for keys, certificates and passwords: stories/s3-audit-refusals.md:10._

Settings in force on the touched calls:

- ledger.client.connect-timeout = 500ms on portal-bff → ledger-api (catalog Setting portal-bff.ledger-connect-timeout)
- ledger.client.read-timeout = 2000ms on portal-bff → ledger-api (catalog Setting portal-bff.ledger-read-timeout)

## Open security-relevant findings

_No critic round has run yet, so there are no findings to show._

## Sign-off

- How: Reviewers approve the design and release hand-off PRs on the Git host with this draft in hand; merging a PR is its sign-off, and atticus change sync records it. The Git host's rules (branch protection, CODEOWNERS) decide who may approve. There is no separate security approval.
- design gate: hand-off PR https://git.example.com/forge/forge-metarepo/pull/2 is merged, approved by avery 2026-10-19.
- release gate: no hand-off PR yet.

## Gaps

- interfaces.md:8: POST /audit/events (portal-bff → audit-svc) says nothing about auth, and the catalog has none.
- interfaces.md:9: POST /risk/assess (ledger-api → risk-engine) says nothing about auth, and the catalog has none.
- ledger-db.limit_change.changed_by_email is judged personal data but is classified internal (data.md:13).
