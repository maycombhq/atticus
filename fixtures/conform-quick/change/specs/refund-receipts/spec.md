## ADDED Requirements

### Requirement: A settled refund gets a receipt

forge-refunds SHALL keep a receipt in refund_receipts for each refund it hears of on forge.refunds.settled, and SHALL publish forge.receipts.issued once the receipt is kept.

#### Scenario: A refund settles

- **GIVEN** a refund that settles
- **WHEN** forge-refunds hears of it on forge.refunds.settled
- **THEN** a receipt is kept and forge.receipts.issued says so

### Requirement: A receipt is served

forge-refunds SHALL serve a refund's receipt at GET /v1/refunds/{id}/receipt, with the account's name read from forge-ledger.

#### Scenario: A receipt is asked for

- **GIVEN** a refund with a receipt
- **WHEN** GET /v1/refunds/{id}/receipt is called
- **THEN** the receipt is returned
