# Raise the daily transfer limit for business accounts

## Change

Business customers hit the daily transfer limit when paying suppliers. The most a business
account may send in one day goes from 10,000 to 50,000; personal accounts keep their limit.

## Where

Sending a transfer (POST /transfers in forge-payments), where the day's total is checked
against the account's limit before the ledger is written.

## Done when

A business account can send up to 50,000 in a day, and the 50,001st is refused with the
limit in the message.
