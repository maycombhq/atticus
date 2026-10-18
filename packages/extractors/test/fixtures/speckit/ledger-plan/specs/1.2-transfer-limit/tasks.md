# Tasks: Check the limit in the transfer transaction

## Phase 1: Setup

- [x] T001 Add the migration in src/main/resources/db/migration/V3__add_daily_limit.sql
- [X] T002 [P] Add LIMIT_EXCEEDED to contracts/ledger-api.yaml

## Phase 2: User Story 1 - Refuse transfers over the daily limit (P1)

- [ ] T003 [US1] Sum today's entries in src/main/java/forge/ledger/TransferLimits.java
- [ ] T004 [US1] Refuse over-limit transfers in src/main/java/forge/ledger/LedgerEndpoints.java
- [ ] T005 [US1] Test the limit in src/test/java/forge/ledger/TransferLimitsTest.java
