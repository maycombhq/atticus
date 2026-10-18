# Implementation Plan: Check the limit in the transfer transaction

**Branch**: `task/add-transfer-limit/1.2` | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/1.2-transfer-limit/spec.md`

## Summary

ledger-api sums today's outgoing entries inside the transfer transaction and refuses the
transfer when the new total would pass the account's daily limit. The developer added a
cache of recent velocity answers while planning.

## Technical Context

**Language/Version**: Java 21
**Primary Dependencies**: Forge framework 3, Spring JDBC
**Storage**: ledger-db (PostgreSQL)
**Testing**: JUnit 5, Testcontainers
**Target Platform**: OpenShift
**Project Type**: single
**Performance Goals**: NEEDS CLARIFICATION
**Constraints**: the limit check adds no more than 20 ms to POST /transfers

### Services this feature calls

| Service | Operation | Via | Pattern | Status |
| --- | --- | --- | --- | --- |
| northwind-pay | POST /v2/velocity-checks | direct | S.GW.VND | planned-new |
| risk-engine | POST /risk/assess | gateway | S.GW.SOR | planned-new |
| fraud-scorer | POST /scores | gateway |  | planned-new |
| audit-svc | publish limit-refused | event-bus | A.EB.PUB | planned-new |

<!-- A row in a comment is not a planned call:
| ignored-svc | GET /nothing | direct |  | planned-new |
-->

## Constitution Check

Every call names its pattern, except the fraud scorer: see Open questions.

## Project Structure

### Documentation (this feature)

```text
specs/1.2-transfer-limit/
├── plan.md
├── data-model.md
├── contracts/
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── main/java/forge/ledger/
│   ├── LedgerEndpoints.java
│   └── TransferLimits.java
└── main/resources/db/migration/
    └── V3__add_daily_limit.sql
```

## Open questions

- Should the fraud scorer be part of the design? It isn't in the change's interfaces.
