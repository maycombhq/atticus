# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| if-d99f508a2ac9b6e0 | portal-bff | ledger-api | S.GW.SOR | POST /transfers | api/ledger-openapi.yaml | planned-modify |
| new | portal-bff | ledger-api | S.GW.SOR | GET /accounts/{id}/limit | api/ledger-openapi.yaml | planned-new |

## Notes

POST /transfers gains the LIMIT_EXCEEDED error (HTTP 422). Both calls go through gw-ledger-v1.
