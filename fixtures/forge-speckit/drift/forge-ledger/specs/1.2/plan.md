# Implementation Plan: Check the limit in the transfer transaction, with tests

**Branch**: `task/add-transfer-limit/1.2` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/1.2/spec.md`

<!-- A seeded drifting plan: the developer edited the handed-down plan heavily. -->

## Summary

ledger-api checks the daily limit in the transfer transaction. While planning, the developer
decided to call Northwind Pay directly, to ask a fraud scorer for a second opinion and to
publish a limit-refused event itself.

## Technical Context

**Language/Version**: Java 21
**Primary Dependencies**: Forge framework 3
**Storage**: ledger-db (postgresql)
**Testing**: JUnit 5
**Target Platform**: kubernetes
**Project Type**: single

### Services this feature calls

| Service | Operation | Via | Pattern | Status |
| --- | --- | --- | --- | --- |
| northwind-pay | POST /v2/velocity-checks | direct | S.GW.VND | planned-new |
| risk-engine | POST /risk/assess | gateway | S.GW.SOR | planned-new |
| fraud-scorer | POST /scores | gateway | S.GW.SOR | planned-new |
| audit-svc | publish limit-refused | event-bus | A.EB.PUB | planned-new |

## Open questions

- None.
