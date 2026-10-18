# Add a daily transfer limit

## Problem

Portal customers can send any amount in one day. Two accounts were drained last month before
anyone noticed, and support had to reverse the transfers by hand.

## Outcome

Each account has a daily transfer limit. A transfer that would go over it is refused with a
clear message, and the customer can see how much of today's limit is left. Support can change
an account's limit, and every change is recorded.

## Scope

In scope: a per-account daily limit on POST /transfers, refusing transfers over it, showing
what is left, recording limit changes, and auditing refusals.
Out of scope: limits per payee, and customers changing their own limit.

## Ledger impact

Ledger checks the limit when it accepts a transfer and stores the limit with the account.

## Partners

Northwind Pay's velocity check flags unusual transfers before the limit is applied, so a
stolen login is caught even under the limit.

## Success measures

No transfer over a limit is accepted; support reversals for drained accounts drop to zero.

## Open questions

- What is the default limit for existing accounts? (product owner)
