---
title: Authorisation checks
owner: Security Architecture
updated: 2026-05-15
---
# Authorisation checks

## Checking who may act

- A service checks that the caller may act on the resource before it changes anything, and answers 403 when it may not.
- A customer may act only on their own orders, refunds and payments.
