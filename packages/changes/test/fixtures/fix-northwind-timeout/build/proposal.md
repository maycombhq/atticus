# Proposal

## Why

Payments to Northwind Pay time out at peak since Northwind slowed their payment API; customers
see failed transfers that later succeed.

## What Changes

- Ledger's call to Northwind Pay waits 8 s instead of 2 s and retries once with the same idempotency key.

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
| ledger | modified | longer timeout and one retry |

## Impact

No API change. Northwind Pay already honours idempotency keys.
