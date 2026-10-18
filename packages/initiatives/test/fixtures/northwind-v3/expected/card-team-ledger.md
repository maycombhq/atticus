# System card: Ledger

Please check what we know about your system, correct anything that is wrong, and answer the open questions. Your reply goes into our intake as a document; nothing here changes without a person reviewing it.

## Systems

| System | Boundary | Owner | Repos |
| --- | --- | --- | --- |
| Ledger (ledger) | product | team-ledger | forge-ledger |

## Components

| Component | Type | Repo |
| --- | --- | --- |
| ledger-api | forge-service | forge-ledger |

## What it offers

| Endpoint | Type | Operation |
| --- | --- | --- |
| ledger-api.get-balance | rest | GET /accounts/{id}/balance |
| ledger-api.post-transfer | rest | POST /transfers |
| topic.transfers-completed | event-topic | transfers.completed |

## Who calls it

| From | To | Via | Operation | Sync |
| --- | --- | --- | --- | --- |
| portal-bff (Portal) | ledger-api | gateway | GET /accounts/{}/balance | sync |
| portal-bff (Portal) | ledger-api | gateway | POST /transfers | sync |
| portal-bff (Portal) | ledger-api | event-bus | payments.initiated | async |

## What it calls

| From | To | Via | Operation | Sync |
| --- | --- | --- | --- | --- |
| ledger-api | northwind-pay | direct | POST /v2/payments | sync |
| ledger-api | reports-job (Reports) | event-bus | transfers.completed | async |

## Data it owns

| Store | Type | Tables |
| --- | --- | --- |
| ledger-db | postgresql | ledger-db.account, ledger-db.entry |

## Open questions

None recorded.

## How to reply

Reply in any form: edit this page, send a document or an e-mail. The reply is saved into the metarepo with `atticus intake add <file>`; it is read like any other document and every fact in it is checked against code.
