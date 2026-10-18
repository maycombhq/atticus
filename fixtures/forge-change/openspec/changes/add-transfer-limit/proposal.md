# Proposal

## Why

Customers can transfer unlimited amounts per day, which let two accounts be drained last month.

## What Changes

- Ledger keeps a daily transfer limit per account and refuses transfers that would exceed it.
- Ledger asks Northwind Pay's velocity check about unusual transfers before applying the limit.
- Support changes to a limit are recorded, and refused transfers are sent to Audit.
- The Portal shows how much of today's limit is left.

## Capabilities

### New Capabilities
- `transfer-limits`: daily limits on outgoing transfers

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
| ledger | modified | checks and stores the limit |
| portal | modified | shows the remaining limit and audits refusals |
| audit | modified | receives limit-refused events |
| northwind-pay | modified | answers velocity checks |

## Impact

POST /transfers returns a new error when a limit is reached. Ledger makes a new call to
Northwind Pay. Audit receives a new event type.

## Open questions

- Default limit for existing accounts — product owner
