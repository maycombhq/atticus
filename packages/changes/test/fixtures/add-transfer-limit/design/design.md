# Design

## Approach

Ledger sums today's outgoing entries for the account inside the transfer transaction and
refuses the transfer when the new total would pass account.daily_limit.

## Decisions

| Decision | Options considered | Chosen because |
| --- | --- | --- |
| Check in Ledger | Portal BFF, gateway policy, Ledger | Ledger owns the balance and the entries |

## Non-functional design

The sum uses idx_entry_account; the BFF keeps its 2 s timeout to Ledger.

## Rollout and rollback

Migration first, then Ledger, then the Portal. Rollback: set every limit very high.

## Risks

Concurrent transfers could both pass the check; the transaction locks the account row.
