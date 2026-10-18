## ADDED Requirements

### Requirement: Redeem a gift card at checkout
The system SHALL take a gift card's balance off the order total before the rest is charged.

#### Scenario: Card covers part of the order
- **WHEN** a shopper redeems a card with 20.00 on an order of 50.00
- **THEN** the card is redeemed for 20.00 and 30.00 is charged

#### Scenario: Card covers the whole order
- **WHEN** a shopper redeems a card with 80.00 on an order of 50.00
- **THEN** the card is redeemed for 50.00, nothing is charged and 30.00 stays on the card
