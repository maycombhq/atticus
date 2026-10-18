# Add transfer limit

## Problem

Portal customers can send any amount in one day. Two accounts were drained last month before
anyone noticed, and support had to reverse the transfers by hand.

## Outcome

Each account has a daily transfer limit. A transfer that would go over it is refused with a
clear message, and the customer can see how much of today's limit is left.

## Scope

In scope: a per-account daily limit, refusing transfers over it, showing what is left.
Out of scope: limits per payee, and changing limits from the Portal.

## Ledger impact

Ledger checks the limit when it accepts a transfer and stores the limit with the account.

## Partners

None.

## Success measures

No transfer over a limit is accepted; support reversals for drained accounts drop to zero.

## Open questions

- What is the default limit for existing accounts? (product owner)
