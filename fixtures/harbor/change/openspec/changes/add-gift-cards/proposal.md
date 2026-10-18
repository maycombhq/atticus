# Proposal

## Why

Gift cards can't be used online; support redeems them by hand after the order.

## What Changes

- The Shop Graph gains a redeemGiftCard mutation; the Orders service applies the card to the order.
- The Payments service redeems the card with Tidewater Payments before it charges the rest.
- The cart reminder asks the Orders service for unused gift card balances.

## Capabilities

### New Capabilities
- `gift-cards`: paying for an order with a gift card

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
| storefront | modified | the redeemGiftCard mutation |
| orders | modified | applies the card to the order |
| payments | modified | redeems the card with Tidewater |
| tidewater-payments | modified | holds gift card balances |

## Impact

New calls from the Shop Graph to Orders, from Orders to Payments and from Payments to Tidewater.

## Open questions

- Partial payment with a gift card — product owner
