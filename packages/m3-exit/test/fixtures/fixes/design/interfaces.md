# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| if-d99f508a2ac9b6e0 | portal-bff | ledger-api | S.GW.SOR | POST /transfers | api/ledger-openapi.yaml | planned-modify |
| new | portal-bff | ledger-api | S.GW.SOR | GET /accounts/{id}/limit | api/ledger-openapi.yaml | planned-new |
| new | ledger-api | northwind-pay | S.GW.VND | POST /v2/velocity-checks | inputs/partner-specs/northwind-pay-openapi.yaml | planned-new |
| if-5c55930b735276a9 | portal-bff | audit-svc | S.GW.SOR | POST /audit/events | none | planned-modify |

## Notes

- POST /transfers gains the LIMIT_EXCEEDED error (HTTP 422) and still goes through gw-ledger-v1.
- GET /accounts/{id}/limit goes through gw-ledger-v1 like the other Portal calls, with the 2 s timeout and circuit breaker portal-bff already uses for ledger-api.
- POST /v2/velocity-checks goes to Northwind Pay through a new gateway proxy, gw-northwind-v2, with mTLS at the gateway; timeout 800 ms, 2 retries with the transfer id as the idempotency key.
- POST /audit/events: portal-bff sends a limit-refused event to audit-svc through the gateway; timeout 1 s and a circuit breaker, and a refusal is never held up by audit.
- The risk-engine call is dropped from this change: risk-engine is not in the catalog yet.
