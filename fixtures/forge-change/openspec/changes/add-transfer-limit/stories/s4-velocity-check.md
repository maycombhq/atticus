# Check unusual transfers with Northwind Pay

As a Portal customer I want unusual transfers checked before they are sent so that a stolen
login is caught even under my limit.

## Acceptance criteria

- Given a transfer that Northwind Pay's velocity check flags, when ledger-api receives the answer, then the transfer is held for review.

## Systems and repos

ledger (forge-ledger), northwind-pay

## Depends on

Nothing.
