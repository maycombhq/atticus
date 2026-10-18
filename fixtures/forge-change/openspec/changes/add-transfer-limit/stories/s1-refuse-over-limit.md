# Refuse transfers over the daily limit

As a Portal customer I want transfers over my daily limit refused so that a stolen login can't
drain my account.

## Acceptance criteria

- Given an account with a limit of 1000 that has sent 900 today, when it asks to send 200, then the transfer is refused with LIMIT_EXCEEDED and nothing is posted.
- Given an account with a limit of 1000 that has sent 900 today, when it asks to send 100, then the transfer is accepted.

## Systems and repos

ledger (forge-ledger)

## Depends on

Nothing.
