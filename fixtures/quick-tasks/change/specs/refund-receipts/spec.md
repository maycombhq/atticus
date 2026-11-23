## ADDED Requirements

### Requirement: A settled refund gets a receipt

forge-refunds SHALL keep a receipt in refund_receipts for each refund it hears of on forge.refunds.settled.

#### Scenario: A refund settles

- **GIVEN** a refund that settles
- **WHEN** forge-refunds hears of it on forge.refunds.settled
- **THEN** a receipt is kept

### Requirement: A receipt is served

forge-refunds SHALL serve a refund's receipt at GET /v1/refunds/{id}/receipt.

#### Scenario: A receipt is asked for

- **GIVEN** a refund with a receipt
- **WHEN** GET /v1/refunds/{id}/receipt is called
- **THEN** the receipt is returned

### Requirement: Receipts have a runbook

The receipts SHALL have a runbook.
