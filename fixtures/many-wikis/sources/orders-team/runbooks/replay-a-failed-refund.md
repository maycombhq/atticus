---
title: Replay a failed refund
owner: Orders team
updated: 2026-09-22
---
# Replay a failed refund

## Steps

1. Find the failed refund in the refunds dead-letter queue by its refund id.
2. Check the payment in forge-payments: a refund already paid is not replayed.
3. Put the refund back on the refunds queue with its original idempotency key.
