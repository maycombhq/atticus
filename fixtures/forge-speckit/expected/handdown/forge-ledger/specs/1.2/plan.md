# Implementation Plan: Check the limit in the transfer transaction, with tests

**Branch**: `task/add-transfer-limit/1.2` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/1.2/spec.md`

<!-- Seeded by Atticus from the approved design of change add-transfer-limit for forge-ledger (component ledger-api). The services table, data-model.md and contracts/ are the design: Atticus reads them on every scan and reports drift, so amend the design through the change instead of here. -->

## Summary

ledger-api sums today's outgoing entries for the account inside the transfer transaction and
refuses the transfer when the new total would pass account.daily_limit. Before the sum, it asks
Northwind Pay's velocity check whether the transfer looks unusual, and asks the risk engine for
a score. portal-bff reads the remaining limit from GET /accounts/{id}/limit and sends a
limit-refused event to audit-svc when ledger-api refuses a transfer.

## Technical Context

**Language/Version**: NEEDS CLARIFICATION
**Primary Dependencies**: NEEDS CLARIFICATION
**Storage**: ledger-db (postgresql)
**Testing**: NEEDS CLARIFICATION
**Target Platform**: kubernetes
**Project Type**: single
**Performance Goals**: NEEDS CLARIFICATION
**Constraints**: NEEDS CLARIFICATION

### Services this feature calls

| Service | Operation | Via | Pattern | Status |
| --- | --- | --- | --- | --- |
| northwind-pay | POST /v2/velocity-checks | gateway | S.GW.VND | planned-new |
| risk-engine | POST /risk/assess | gateway | S.GW.SOR | planned-new |

### Operations this feature serves

| Operation | Caller | Pattern | Status | Contract |
| --- | --- | --- | --- | --- |
| POST /transfers | portal-bff | S.GW.SOR | planned-modify | contracts/ledger-api.yaml |
| GET /accounts/{id}/limit | portal-bff | S.GW.SRO | planned-new | contracts/ledger-api.yaml |

### Field mappings

#### POST /transfers

No mapping change. The response gains error LIMIT_EXCEEDED (HTTP 422) with the remaining limit.

#### GET /accounts/{id}/limit

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| account.daily_limit | limit | as is | 404 when the account is unknown |
| sum of today's outgoing entries | remaining | limit minus the sum, never below 0 | 0 |

#### POST /v2/velocity-checks

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| account.account_number | accountRef | hashed with the shared key | refuse the transfer |
| transfer amount | amount.value | as is, two decimals | refuse the transfer |

## Constitution Check

[NEEDS CLARIFICATION: check each principle of `.specify/memory/constitution.md`, generated from the org pack]

## Project Structure

### Documentation (this feature)

```text
specs/1.2/
├── plan.md
├── data-model.md
├── contracts/
└── tasks.md
```

### Source Code (repository root)

```text
[NEEDS CLARIFICATION: the files this feature adds or changes]
```

## Open questions

- None yet. Anything that needs the change's design goes here; it goes back up as an owner question.
