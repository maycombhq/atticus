# Design

## Context

Refunds settle with no receipt.

## Decisions

- forge-refunds keeps the receipts in a table of its own.

## In the code

| Repo          | Task | Has       | What                                   | Spec                                             |
| ------------- | ---- | --------- | -------------------------------------- | ------------------------------------------------ |
| forge-refunds | r1   | listens   | `forge.refunds.settled`                | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r1   | table     | `refund_receipts`                      | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r1   | column    | `refund_receipts.issued_at`            | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r1   | migration | `V7__refund_receipts.sql`              | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r1   | publishes | `forge.receipts.issued`                | refund-receipts: A settled refund gets a receipt |
| forge-refunds | r2   | serves    | `GET /v1/refunds/{id}/receipt`         | refund-receipts: A receipt is served             |
| forge-refunds | r2   | calls     | `forge-ledger GET /v1/accounts/{id}`   | refund-receipts: A receipt is served             |
| forge-refunds | -    | other     | Receipts are kept for seven years.     | -                                                |

## Risks

None known.
