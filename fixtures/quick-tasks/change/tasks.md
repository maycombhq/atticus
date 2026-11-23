## forge-refunds

- [ ] r1 Keep a receipt for each settled refund
  - Given a refund that settles, when forge-refunds hears of it on `forge.refunds.settled`, then a receipt is kept in refund_receipts.
  - Given the receipt's write fails, when a refund settles, then the event is not acknowledged and is read again.
- [ ] r2 Serve a refund's receipt (after r1)
- [ ] r3 Read the account's name from forge-ledger (after r1)
  - Given a receipt, when GET /v1/receipts/{id}/audit is called, then the account's name is in it.
- [ ] r4 Write the receipts runbook
- [ ] r5 Serve a receipt as a PDF (after r2)

### Notes

  - Given a note under a heading, when it is read, then it is no task's criterion.
