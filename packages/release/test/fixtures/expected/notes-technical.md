# Release notes: Add a daily transfer limit

For technical readers. Change `add-transfer-limit`, generated 2026-10-21 from the change folder; every line says where it came from.

## Why

Portal customers can send any amount in one day. Two accounts were drained last month before anyone noticed, and support had to reverse the transfers by hand.

Source: brief.md:3

## What changes

- Ledger keeps a daily transfer limit per account and refuses transfers that would exceed it.
- Ledger asks Northwind Pay's velocity check about unusual transfers before applying the limit.
- Support changes to a limit are recorded, and refused transfers are sent to Audit.
- The Portal shows how much of today's limit is left.

Source: proposal.md:7

## Who it affects

- Ledger (modified): checks and stores the limit
- Portal (modified): shows the remaining limit and audits refusals
- Audit (modified): receives limit-refused events
- Northwind Pay (modified): answers velocity checks

Source: proposal.md:21

## API changes

| Operation | Caller → callee | Change | Breaking | Why | Source |
| --- | --- | --- | --- | --- | --- |
| POST /transfers | portal-bff → ledger-api | modify | yes (judged by a model) | POST /transfers gains the LIMIT_EXCEEDED error (HTTP 422) and still goes through gw-ledger-v1. | interfaces.md:5 |
| GET /accounts/{id}/limit | portal-bff → ledger-api | new | no (by its change kind) | A new operation in this change, so no existing caller breaks. | interfaces.md:6 |
| POST /v2/velocity-checks | ledger-api → northwind-pay (Northwind Pay, a vendor) | new | no (by its change kind) | A new operation in this change, so no existing caller breaks. | interfaces.md:7 |
| POST /audit/events | portal-bff → audit-svc | modify | check (a judge couldn't tell) | A judge couldn't tell whether callers must change, so a person checks: POST /audit/events: portal-bff sends a limit-refused event to audit-svc. | interfaces.md:8 |
| POST /risk/assess | ledger-api → risk-engine | new | no (by its change kind) | A new operation in this change, so no existing caller breaks. | interfaces.md:9 |

## Data changes

| Table | Change | Migration | Source |
| --- | --- | --- | --- |
| ledger-db.account | add column daily_limit numeric(18,2) not null default 1000 | V3__add_daily_limit.sql | data.md:7 |
| ledger-db.limit_change | new table limit_change (id bigint, account_id bigint, old_limit numeric(18,2), new_limit numeric(18,2), changed_by_email varchar(200), changed_at timestamp) | none named | data.md:8 |

## Impact

POST /transfers returns a new error when a limit is reached. Ledger makes a new call to Northwind Pay. Audit receives a new event type.

Source: proposal.md:28

## Not included

- Limits per payee, and customers changing their own limit

Source: brief.md:14

## Known limitations

_No critic round has run yet, so no finding is waived._
