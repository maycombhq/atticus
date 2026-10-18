# Ledger Platform: solution spec

Owner: Ledger team (ledger-team@forge.example)

The Ledger Platform keeps accounts and entries. The portal reads balances and creates transfers through the gateway.
Payments to Northwind Pay go out through the gateway (pattern S.GW.VND).
Reports read entries through the Ledger API.

Service level: 99.9% monthly availability. Peak load: 200 requests per second.
