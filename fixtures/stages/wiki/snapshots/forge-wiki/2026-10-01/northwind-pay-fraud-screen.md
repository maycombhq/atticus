# Northwind Pay fraud screen

How Forge services call Northwind Pay's fraud screen. The payments team owns this page.

## Calling the screen

Send the order's amount, currency and card fingerprint to the fraud screen before any stock is
reserved. The screen answers with a verdict: approve, review or reject.

## Timeouts and retries

The fraud screen answers within 800 ms. Call it with a 2 second timeout and one retry. When it
still fails, hold the order for review instead of refusing it.

## Verdict webhook

A review verdict is settled later: Northwind Pay posts the final verdict to the order's webhook,
signed with the shared secret. Check the signature before the verdict is stored with the order.
