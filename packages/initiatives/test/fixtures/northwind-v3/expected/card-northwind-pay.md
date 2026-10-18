# System card: Northwind Pay

For: Northwind Pay v3 migration (initiative northwind-pay-v3-migration)
Asked of: Northwind Pay (party.northwind-pay), by pat on 2027-01-04
Reply by: 2027-01-11

Please check what we know about your system, correct anything that is wrong, and answer the open questions. Your reply goes into our intake as a document; nothing here changes without a person reviewing it.

## Systems

| System | Boundary | Owner | Repos |
| --- | --- | --- | --- |
| Northwind Pay (northwind-pay) | vendor | unknown | none |

## What it offers

| Endpoint | Type | Operation |
| --- | --- | --- |
| northwind-pay.post-payment | rest | POST /v2/payments |

## Who calls it

| From | To | Via | Operation | Sync |
| --- | --- | --- | --- | --- |
| ledger-api (Ledger) | northwind-pay | direct | POST /v2/payments | sync |

## What it calls

None known.

## Data it owns

None known.

## Open questions

- (oq.northwind-pay.rate-limit) What rate limit applies to POST /v2/payments per merchant? Needed: rate limit of POST /v2/payments. Asked of: Northwind Pay partner desk (sent)

## How to reply

Reply in any form: edit this page, send a document or an e-mail. The reply is saved into the metarepo with `atticus intake add <file>`; it is read like any other document and every fact in it is checked against code.
