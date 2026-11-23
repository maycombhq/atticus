# Design

## Context

Refunds settle with no receipt.

## In the code

| Repo          | Task | Has     | What                                 | Spec                                             |
| ------------- | ---- | ------- | ------------------------------------ | ------------------------------------------------ |
| forge-refunds | r1   | listens | `forge.refunds.settled`              | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r1   | table   | `refund_receipts`                    | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r2   | serves  | `GET /v1/refunds/{id}/receipt`       | refund-receipts: A receipt is served             |
| forge-refunds | r3   | calls   | `forge-ledger GET /v1/accounts/{id}` | -                                                |
| forge-refunds | r4   | other   | The receipts runbook.                | refund-receipts: Receipts have a runbook         |
| forge-refunds | r5   | serves  | `GET /v1/refunds/{id}/receipt.pdf`   | refund-receipts: A receipt is served             |
