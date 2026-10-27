---
title: Check the caller's customer id
owner: Identity team
updated: 2026-07-14
---
# Check the caller's customer id

## Steps

1. Read the customer id from the token's sub claim, never from a request header.
2. Compare it with the order's customer id before the refund is created.
3. Answer 403 when they differ.
