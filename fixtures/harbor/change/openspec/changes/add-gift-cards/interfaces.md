# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| new | shop-graph | orders-svc | HB.SYNC.MESH | POST /orders/{id}/gift-card | none | planned-new |
| new | orders-svc | payments-svc | HB.SYNC.MSH | POST /gift-cards/redeem | none | planned-new |
| new | payments-svc | tidewater-payments | HB.VND.EGRESS | POST /v1/gift-cards/{code}/redeem | inputs/partner-specs/tidewater-payments-openapi-v2.yaml | planned-new |
| if-a4ccfcea11eeebf0 | payments-svc | tidewater-payments | HB.VND.EGRESS | POST /v1/charges | inputs/partner-specs/tidewater-payments-openapi-v2.yaml | planned-modify |
| if-0fe11f6ee6c3429f | cart-reminder | orders-svc |  | GET /carts/abandoned | none | planned-modify |

## Notes

- POST /orders/{id}/gift-card keeps the mesh's 2 s timeout.
- POST /gift-cards/redeem has a 2 s timeout and no retries: redeeming twice would spend the card twice.
- POST /v1/gift-cards/{code}/redeem leaves through the egress route gw-egress-tidewater with a 5 s timeout and 2 retries with an idempotency key.
- POST /v1/charges keeps its 5 s timeout and 2 retries with an idempotency key, and moves to gw-egress-tidewater.
- GET /carts/abandoned returns each cart's unused gift card balance as well.
