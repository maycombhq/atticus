# Fraud screen: my analysis

Notes from walking through the order screen with the support desk, 2026-10-20.

## Acceptance criteria

- A rejected order tells the shopper: "We couldn't accept this order. Please use another card."
- An order Northwind Pay marks as review is refused like a rejected one until the review desk exists.

## Edge cases

- Northwind Pay answers with a verdict we don't know: refuse the order with 502 and reserve nothing.
