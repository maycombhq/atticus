# Ledger (ledger)

Product system · confidence: verified · owner: team-ledger _(forge-ledger/forge.yaml:3)_

Repos: forge-ledger

## What it is made of

| Component | Type | Runs on | Repo |
| --- | --- | --- | --- |
| ledger-api | forge-service | kubernetes | forge-ledger |

## Who it talks to

Calls out:

| With | Operation | Via | Auth | Pattern | Confidence |
| --- | --- | --- | --- | --- | --- |
| northwind-pay | POST /v2/payments | direct | not declared | none | verified |
| reports-job (reports) | transfers.completed | event-bus | not declared | A.EB.PUB | verified |
| fraud-lab | POST /score | direct | not declared | none | verified |

Called by:

| With | Operation | Via | Auth | Pattern | Confidence |
| --- | --- | --- | --- | --- | --- |
| portal-bff (portal) | GET /accounts/{}/balance | gateway | oauth2 | S.GW.SOR | verified |
| portal-bff (portal) | POST /transfers | gateway | oauth2 | S.GW.SOR | verified |
| portal-bff (portal) | payments.initiated | event-bus | not declared | A.EB.PUB | verified |

- 2 calls have no authentication declared in code or config.

## Data

- **ledger-db** (postgresql) _(forge-infra/terraform/ledger-db.tf:1)_

| Table | Written by | Read by | Classified columns |
| --- | --- | --- | --- |
| ledger-db.account | ledger-api | ledger-api | none of 3 tagged |
| ledger-db.entry | ledger-api | ledger-api, reports-job (reports) | none of 4 tagged |

## Runtime

- ledger-api in prod on kubernetes, 3 replicas _(forge-infra/k8s/ledger-api.yaml:7)_
- alert: Ledger API error rate _(forge-infra/alerts/ledger-api.yaml:3)_

## Decisions

- **Check the daily limit in Ledger** (2026-10-01, priya): Ledger checks the limit inside the transfer transaction. Because: Ledger owns the balance and the entries.

## Changes touching it

- Add a daily transfer limit (add-transfer-limit, plan)

## What the catalog doesn't know yet

Nothing flagged.
