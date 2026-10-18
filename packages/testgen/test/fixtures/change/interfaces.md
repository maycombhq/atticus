# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| if-d99f508a2ac9b6e0 | portal-bff | ledger-api | S.GW.SOR | POST /transfers | api/ledger-openapi.yaml | planned-modify |
| new | portal-bff | ledger-api | S.GW.SRO | GET /accounts/{id}/limit | api/ledger-openapi.yaml | planned-new |
| new | ledger-api | northwind-pay | S.GW.VND | POST /v2/velocity-checks | inputs/partner-specs/northwind-pay-openapi.yaml | planned-new |
| if-5c55930b735276a9 | portal-bff | audit-svc |  | POST /audit/events | none | planned-modify |
| new | ledger-api | risk-engine | S.GW.SOR | POST /risk/assess | none | planned-new |
| new | ledger-api | reports-job | A.EB.PUB | publish limits.changed | none | planned-new |

## Notes

- POST /transfers gains the LIMIT_EXCEEDED error (HTTP 422) and still goes through gw-ledger-v1.
- GET /accounts/{id}/limit goes through gw-ledger-v1 like the other Portal calls.
- POST /v2/velocity-checks goes to Northwind Pay through a new gateway proxy, gw-northwind-v2, with mTLS at the gateway.
- POST /audit/events: portal-bff sends a limit-refused event to audit-svc.
- POST /risk/assess: ledger-api asks the risk engine for a score before applying the limit.
- publish limits.changed: ledger-api publishes a limits.changed event when support changes a limit; reports-job reads it.
