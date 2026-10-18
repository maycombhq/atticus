# Design

## Approach

ledger-api sums today's outgoing entries for the account inside the transfer transaction and
refuses the transfer when the new total would pass account.daily_limit. Before the sum, it asks
Northwind Pay's velocity check whether the transfer looks unusual, and asks the risk engine for
a score. portal-bff reads the remaining limit from GET /accounts/{id}/limit and sends a
limit-refused event to audit-svc when ledger-api refuses a transfer.

## Decisions

| Decision | Options considered | Chosen because |
| --- | --- | --- |
| Check in Ledger | Portal BFF, gateway policy, Ledger | Ledger owns the balance and the entries |
| Velocity check before the limit | after the limit, not at all | catches stolen logins under the limit |

## Non-functional design

portal-bff keeps its 2 s read timeout and its circuit breaker to ledger-api through gw-ledger-v1.
The sum uses idx_entry_account, so it reads only the account's entries.

## Rollout and rollback

Migration first, then ledger-api, then portal-bff and portal-ui.

## Risks

Concurrent transfers from the same account could both pass the check.
