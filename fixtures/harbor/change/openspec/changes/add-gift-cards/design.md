# Design

## Approach

shop-graph adds a redeemGiftCard mutation that calls orders-svc. orders-svc asks payments-svc to
redeem the card for at most the order total, then asks for a charge of the rest. payments-svc
redeems the card with Tidewater Payments before it creates the charge.

## Decisions

| Decision | Options considered | Chosen because |
| --- | --- | --- |
| Redeem in Payments | Orders, Payments | Payments already holds the Tidewater key and the egress route |
| Redeem before charging | after, at the same time | a failed redeem must not leave a charge behind |

## Non-functional design

Every call keeps the timeouts stated in interfaces.md. payments-svc keeps its PaymentsTidewaterLatency alert.

## Rollout and rollback

payments-svc first, then orders-svc, then shop-graph, the apps and cart-reminder. Rolling back
in the reverse order is safe: no data changes.

## Risks

A redeem that times out may have spent the card; the idempotency key lets the retry find it.
