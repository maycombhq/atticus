# Service-desk requests

## Gateway proxy deployment: gw-northwind-v2

| Field | Value |
| --- | --- |
| Proxy name | gw-northwind-v2 |
| Base path | /northwind/v2 |
| Target | https://api.northwind.example/v2 |
| Environment | prod |
| Justification | ledger-api calls Northwind Pay's velocity check through the gateway |
| Unblocks task | 1.3 |
