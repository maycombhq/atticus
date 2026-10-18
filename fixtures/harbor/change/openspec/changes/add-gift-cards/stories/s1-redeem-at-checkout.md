# Redeem a gift card at checkout

As a shopper I want to pay with my gift card at checkout so that I don't wait for a refund.

## Acceptance criteria

- Given a card with 20.00 and an order of 50.00, when I redeem the card, then the card is redeemed for 20.00 and 30.00 is charged.
- Given a card with 80.00 and an order of 50.00, when I redeem the card, then nothing is charged and 30.00 stays on the card.

## Systems and repos

storefront (harbor-graph), orders (harbor-orders), payments (harbor-payments), tidewater-payments

## Depends on

Nothing.
