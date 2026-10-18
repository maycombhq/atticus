# Money transfers Specification

<!-- Drafted by Atticus from feature feature.transfers, confirmed by a.owner. The requirements say what the code does today: check each one and describe its results before this spec is merged. -->

## Purpose

Moves money between accounts through the ledger and tells reporting when a transfer completes.

Where it is in code:

- ledger-api.post-transfer: forge-ledger src/main/java/forge/ledger/LedgerEndpoints.java:11, forge-ledger api/ledger-openapi.yaml:14
- if-f1cd1f189eaa4b7b: forge-ledger src/main/java/forge/ledger/LedgerEvents.java:9, forge-events topics/transfers.completed.yaml:1, forge-reports-job src/main/java/forge/reports/DailyEntriesJob.java:17

## Requirements

### Requirement: POST /transfers
The system SHALL serve POST /transfers on ledger-api.

#### Scenario: POST /transfers is called
- **WHEN** a caller sends POST /transfers to ledger-api
- **THEN** ledger-api answers <!-- describe the observable result -->

### Requirement: Handle transfers.completed
The system SHALL start work in reports-job when ledger-api publishes transfers.completed.

#### Scenario: transfers.completed is published
- **WHEN** ledger-api publishes transfers.completed
- **THEN** reports-job handles it <!-- describe what it does next -->
