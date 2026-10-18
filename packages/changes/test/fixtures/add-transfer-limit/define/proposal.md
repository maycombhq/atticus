# Proposal

## Why

Customers can transfer unlimited amounts per day, which let two accounts be drained last month.

## What Changes

- Ledger keeps a daily transfer limit per account and refuses transfers that would exceed it.
- The Portal shows how much of today's limit is left.

## Capabilities

### New Capabilities
- `transfer-limits`: daily limits on outgoing transfers

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
| ledger | modified | checks and stores the limit |
| portal | modified | shows the remaining limit |

## Impact

The transfer API returns a new error when a limit is reached. No partner changes.

## Open questions

- Default limit for existing accounts — product owner
