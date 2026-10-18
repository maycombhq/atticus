# Outputs for a person to grade

These are the answers the live runs wrote for the exits that need a person's judgement. Nothing here is pass or fail until a person says so. A run's exit passes when its outputs are accepted with wording-only edits and the deterministic parts are unchanged; the exit needs 4 of 5 runs.

- **Feature namer**: are the names for feature.transfers, feature.payments, feature.account-balance and feature.daily-entries-report ones a Forge person would accept? Check each against the ADO stories (`fixtures/forge/inputs/tickets`) and the wiki pages (`fixtures/forge/inputs/wiki`): the description says only what the evidence shows, the tags fit, nothing is invented.
- **Test namer**: do the scenario, case and data names read as a tester would write them, and do they match the cases of the story (`tests/s2-remaining-limit/manifest.yaml` lists them)?
- **Glossary definer**: is each definition one sentence, true to how the code uses the term, nothing invented?
- **Template drafter**: is the prose of each request template and procedure clear, and does it agree with the how-to pages and tickets it came from?

## Feature namer (catalog/proposals/capability/*.yaml)

### run-1

| Feature | Proposed name | Tags | Description |
| --- | --- | --- | --- |
| feature.account-balance | Account balance lookup | accounts, balance, portal, ledger | Lets a Portal user see the balance of an account. The Portal screen (portal-ui) asks portal-bff for the balance, and portal-bff gets it from ledger-api, which reads it from the account table in ledger-db. |
| feature.daily-entries-report | Daily ledger entries report | reporting, ledger, batch | A batch job, reports-job (DailyEntriesJob), that works from the entries in ledger-db to produce the daily entries report. It is also the receiver of the transfers.completed event, so it hears about completed transfers from ledger-api. |
| feature.payments | Payment initiation | payments, portal, ledger, vendor | Starts a payment from the Portal. portal-bff publishes a payments.initiated event, ledger-api picks it up and works with the entries in ledger-db, and ledger-api also asks the vendor Northwind Pay to make the payment with POST /v2/payments. |
| feature.transfers | Account transfers | transfers, ledger, portal | Lets portal-bff ask ledger-api to make a transfer with POST /transfers, which works with the entries in ledger-db. When a transfer is completed, ledger-api publishes a transfers.completed event that reports-job receives. |

### run-2

| Feature | Proposed name | Tags | Description |
| --- | --- | --- | --- |
| feature.account-balance | Account balance view | balance, accounts, portal, ledger | Lets a customer see the balance of an account in the Portal. The Portal screen (portal-ui) asks the Portal's back end (portal-bff), which fetches the balance from the Ledger service (ledger-api) through its GET /accounts/{id}/balance operation, and the balance comes from the account table in the ledger database. |
| feature.daily-entries-report | Daily entries report | reporting, ledger, batch | A scheduled batch job (reports-job, in the reports system) that reads the ledger entries held in the ledger database to produce the daily report of entries. |
| feature.payments | Payment initiation | payments, portal, ledger, partner | Starts a payment from the Portal. The Portal's back end (portal-bff) publishes a payments.initiated event, which the Ledger service (ledger-api) picks up; ledger-api records the payment against the ledger entries and sends it on to the payment partner Northwind Pay through its POST /v2/payments operation. |
| feature.transfers | Money transfers | transfers, portal, ledger, reporting | Lets the Portal send a transfer through the Ledger service. The Portal's back end (portal-bff) calls POST /transfers on ledger-api, which works on the ledger entries, and ledger-api then publishes a transfers.completed event that the daily entries job (reports-job) reads. |

### run-3

| Feature | Proposed name | Tags | Description |
| --- | --- | --- | --- |
| feature.account-balance | Account balance lookup | accounts, balance, portal, ledger | Lets a customer see the balance of an account in the Portal. The Portal screen (portal-ui) asks portal-bff for the balance with GET /api/balance/{accountId}, and portal-bff in turn asks ledger-api for it with GET /accounts/{id}/balance. ledger-api answers from the account data it keeps in ledger-db. |
| feature.daily-entries-report | Daily ledger entries report | reporting, ledger, batch | A scheduled batch job (reports-job, in the reports system) that produces the daily entries report. It reads the ledger entries held in the ledger-db entry table. Nothing in the evidence shows who receives the report or in what form. |
| feature.payments | Payment initiation | payments, portal, ledger, northwind | Lets a payment started in the Portal reach Ledger and the payment partner. portal-bff publishes a payments.initiated event, which ledger-api picks up. ledger-api then sends the payment to Northwind Pay with POST /v2/payments and keeps its records in the ledger-db entry table. |
| feature.transfers | Account transfers | transfers, ledger, portal, reporting | Lets portal-bff ask ledger-api to make a transfer, with POST /transfers, and records it in the ledger-db entry table. When a transfer is done, ledger-api publishes a transfers.completed event, which the daily entries job in the reports system (reports-job) reads. |

### run-4

| Feature | Proposed name | Tags | Description |
| --- | --- | --- | --- |
| feature.account-balance | Check account balance | accounts, balance, portal | Lets a customer see the balance of an account in the portal. The portal screen asks portal-bff for the balance, portal-bff asks ledger-api, and ledger-api reads it from the account table in ledger-db. |
| feature.daily-entries-report | Daily entries report | reporting, ledger, batch | A nightly batch job, reports-job, that reads the ledger entries from the entry table in ledger-db and builds the daily report of entries. It is not a customer screen; it serves the people who use the report. |
| feature.payments | Send a payment | payments, partner, events | Starts a payment from the portal. portal-bff publishes a payments.initiated event, ledger-api picks it up and records it in the entry table of ledger-db, and ledger-api then asks the payment partner Northwind Pay to make the payment. |
| feature.transfers | Transfer money | transfers, ledger, events | Lets a customer transfer money from an account. portal-bff sends the transfer request to ledger-api, which records it in the entry table of ledger-db. When a transfer is completed, ledger-api publishes a transfers.completed event that reports-job reads. |

### run-5

| Feature | Proposed name | Tags | Description |
| --- | --- | --- | --- |
| feature.account-balance | Account balance lookup | balances, accounts, portal, ledger | Lets a person using the Portal see the balance of an account. The Portal screen asks portal-bff for the balance, portal-bff asks ledger-api for it through the gateway, and ledger-api reads the account in ledger-db. |
| feature.daily-entries-report | Daily entries report | reporting, entries, ledger, batch | A daily batch job in the reports system, reports-job, that reads the entries held in ledger-db. It is also the receiver of the transfers.completed event that ledger-api publishes when a transfer is completed. |
| feature.payments | Payment initiation | payments, partners, events, ledger | Starts a payment from the Portal. portal-bff publishes a payments.initiated event, ledger-api picks it up and works on the entries in ledger-db, and ledger-api then calls Northwind Pay (POST /v2/payments) so the payment goes out to the partner. |
| feature.transfers | Money transfers | transfers, ledger, portal, events | Lets the Portal create a transfer. portal-bff calls POST /transfers on ledger-api through the gateway, ledger-api works on the entries in ledger-db, and once a transfer is done it publishes a transfers.completed event that the daily entries report job in the reports system reads. |

## Test namer (tests/s2-remaining-limit/names.yaml)

### run-1

```yaml
scenarios:
  - id: acceptance.c1
    name: Remaining limit is 100 after sending 900 of a 1000 limit
  - id: acceptance.c2
    name: Unknown account gets a 404 from the limit lookup
cases:
  - id: api.get-accounts-limit.happy
    name: Return the limit and remaining limit for a valid request
  - id: contract.get-accounts-limit.provider
    name: Serve GET /accounts/{id}/limit the way portal-bff expects
  - id: contract.get-accounts-limit.consumer
    name: Call GET /ledger/v1/accounts/{id}/limit the way the contract says
data: []
```


### run-2

```yaml
scenarios:
  - id: acceptance.c1
    name: Customer sees limit 1000 and remaining 100 after sending 900 today
  - id: acceptance.c2
    name: Limit request for an unknown account is answered with 404
cases:
  - id: api.get-accounts-limit.happy
    name: Accept a valid request for an account's limit
  - id: contract.get-accounts-limit.provider
    name: Serve the account limit as portal-bff expects
  - id: contract.get-accounts-limit.consumer
    name: Call the account limit through the ledger gateway as the contract says
data: []
```


### run-3

```yaml
scenarios:
  - id: acceptance.c1
    name: Remaining limit is shown after some of it was used today
  - id: acceptance.c2
    name: Limit request for an unknown account is answered with 404
cases:
  - id: api.get-accounts-limit.happy
    name: Accept a valid request for an account's limit
  - id: contract.get-accounts-limit.provider
    name: Check that ledger-api serves the limit as portal-bff expects
  - id: contract.get-accounts-limit.consumer
    name: Check that portal-bff asks for the limit as ledger-api's contract says
data: []
```


### run-4

```yaml
scenarios:
  - id: acceptance.c1
    name: Customer sees limit 1000 and remaining 100 after sending 900 today
  - id: acceptance.c2
    name: Unknown account gets a 404 when asking for its limit
cases:
  - id: api.get-accounts-limit.happy
    name: Accept a valid request for an account's limit
  - id: contract.get-accounts-limit.provider
    name: Serve the account limit the way portal-bff expects
  - id: contract.get-accounts-limit.consumer
    name: Call the account limit the way ledger-api's contract says
data: []
```


### run-5

```yaml
scenarios:
  - id: acceptance.c1
    name: Customer sees 100 left after sending 900 of a 1000 daily limit
  - id: acceptance.c2
    name: Limit lookup for an unknown account is answered with 404
cases:
  - id: api.get-accounts-limit.happy
    name: Accept a valid request for an account's remaining limit
  - id: contract.get-accounts-limit.provider
    name: Serve the limit lookup the way portal-bff expects
  - id: contract.get-accounts-limit.consumer
    name: Call the ledger limit lookup the way ledger-api's contract says
data: []
```


## Glossary definer (the answer file; `handoff done` saves its definitions as proposals)

### run-1

```yaml
terms:
  - id: term.account
    definition: An account is the record Ledger keeps for a customer's money, which has a balance and to which entries are posted.
    evidence: [ledger-db.account, ledger-api.get-balance, ledger-db.entry.account-id]
  - id: term.account-number
    definition: An account number is the identifier stored with each account that tells one account apart from another.
    evidence: [ledger-db.account.account-number]
  - id: term.balance
    definition: A balance is the amount of money an account holds, which Portal users can look up.
    evidence: [ledger-api.get-balance, portal-bff.get-balance]
  - id: term.entry
    definition: An entry is a single line posted to an account in Ledger, belonging to one account.
    evidence: [ledger-db.entry, ledger-db.entry.account-id]
  - id: term.holder-name
    definition: A holder name is the name of the person or organisation that an account is held for.
    evidence: [ledger-db.account.holder-name]
  - id: term.payment
    definition: A payment is a request to move money out through the vendor Northwind Pay, started in the Portal and announced as a payment initiated event.
    evidence: [northwind-pay.post-payment, topic.payments-initiated]
  - id: term.transfer
    definition: A transfer is a request that Ledger carries out to move money, and Ledger announces it when it is completed.
    evidence: [ledger-api.post-transfer, topic.transfers-completed]
```


### run-2

```yaml
terms:
  - id: term.account
    definition: An account is a customer's record in the ledger, with its own account number and holder name, whose balance can be looked up and to which ledger entries are attached.
    evidence: [ledger-db.account, ledger-api.get-balance, ledger-db.entry.account-id]
  - id: term.account-number
    definition: The account number is the identifier kept on each account in the ledger that tells accounts apart.
    evidence: [ledger-db.account.account-number]
  - id: term.balance
    definition: The balance is the amount an account holds, which the Portal and the ledger let a customer look up for one account.
    evidence: [ledger-api.get-balance, portal-bff.get-balance]
  - id: term.entry
    definition: An entry is one line in the ledger that belongs to an account, with an amount and the time it was posted.
    evidence: [ledger-db.entry, ledger-db.entry.account-id]
  - id: term.holder-name
    definition: The holder name is the name of the person or party the account is held by, as recorded on the account.
    evidence: [ledger-db.account.holder-name]
  - id: term.payment
    definition: A payment is a request to pay someone, started in the Portal and sent on to the payment partner Northwind Pay.
    evidence: [topic.payments-initiated, northwind-pay.post-payment]
  - id: term.transfer
    definition: A transfer is a movement of money requested through the ledger, and the ledger announces each completed transfer to the rest of the estate.
    evidence: [ledger-api.post-transfer, topic.transfers-completed]
```


### run-3

```yaml
terms:
  - id: term.account
    definition: "An account is the record Ledger keeps for a customer's money, which has a balance that can be looked up and entries posted against it."
    evidence: [ledger-db.account, ledger-api.get-balance, ledger-db.entry.account-id]
  - id: term.account-number
    definition: "The account number is the number stored with an account in Ledger that identifies that account."
    evidence: [ledger-db.account.account-number]
  - id: term.balance
    definition: "The balance is the amount an account holds, which Ledger can report for an account and the Portal shows to the customer."
    evidence: [ledger-api.get-balance, portal-bff.get-balance]
  - id: term.entry
    definition: "An entry is a single line posted against an account in Ledger's books."
    evidence: [ledger-db.entry, ledger-db.entry.account-id]
  - id: term.holder-name
    definition: "The holder name is the name of the person or party the account is held for, kept with the account in Ledger."
    evidence: [ledger-db.account.holder-name]
  - id: term.payment
    definition: "A payment is a request to pay out that starts in the Portal as a payments.initiated event and is sent on to the payment partner Northwind Pay."
    evidence: [topic.payments-initiated, northwind-pay.post-payment]
  - id: term.transfer
    definition: "A transfer is a request to move money that Ledger accepts through POST /transfers and announces as completed when it is done."
    evidence: [ledger-api.post-transfer, topic.transfers-completed]
```


### run-4

```yaml
terms:
  - id: term.account
    definition: "An account is what the ledger keeps for a customer: it has a balance that can be read, and the entries recorded in the ledger are tied to it."
    evidence: [ledger-api.get-balance, ledger-db.account, ledger-db.entry.account-id]
  - id: term.account-number
    definition: "The account number is the identifier of an account that is stored with the account in the ledger."
    evidence: [ledger-db.account.account-number]
  - id: term.balance
    definition: "The balance is what an account holds at the moment it is asked for, which a customer can see through the portal and the ledger provides."
    evidence: [ledger-api.get-balance, portal-bff.get-balance]
  - id: term.entry
    definition: "An entry is a single record the ledger keeps against an account."
    evidence: [ledger-db.entry]
  - id: term.holder-name
    definition: "The holder name is the name of the person or party the account is held by, stored with the account in the ledger."
    evidence: [ledger-db.account.holder-name]
  - id: term.payment
    definition: "A payment is a request to pay that the portal starts and the payment partner Northwind Pay is asked to carry out."
    evidence: [northwind-pay.post-payment, topic.payments-initiated]
  - id: term.transfer
    definition: "A transfer is a request to move money that is sent to the ledger and announced to other systems once it has been completed."
    evidence: [ledger-api.post-transfer, topic.transfers-completed]
```


### run-5

```yaml
terms:
  - id: term.account
    definition: An account is what the Ledger keeps for a customer, with a balance that can be looked up and entries recorded against it.
    evidence: [ledger-db.account, ledger-api.get-balance, ledger-db.entry.account-id]
  - id: term.account-number
    definition: The account number is the number that identifies an account and is stored with it.
    evidence: [ledger-db.account.account-number]
  - id: term.balance
    definition: The balance is the amount an account holds, which the Portal asks the Ledger for when someone looks at an account.
    evidence: [ledger-api.get-balance, portal-bff.get-balance]
  - id: term.entry
    definition: An entry is one line the Ledger records against an account.
    evidence: [ledger-db.entry, ledger-db.entry.account-id]
  - id: term.holder-name
    definition: The holder name is the name of whoever holds the account, kept with the account.
    evidence: [ledger-db.account.holder-name]
  - id: term.payment
    definition: A payment is money sent out to Northwind Pay, started when a payment is initiated in the Portal.
    evidence: [northwind-pay.post-payment, topic.payments-initiated]
  - id: term.transfer
    definition: A transfer is a movement of money created in the Ledger through the transfers service, and announced as completed once it is done.
    evidence: [ledger-api.post-transfer, topic.transfers-completed]
```


## Template drafter (prose.yaml)

### run-1

```yaml
templates:
  - id: firewall-rule
    summary: A "Network firewall rule" request asks the network team to approve and set up a firewall rule between a source app and a destination host. A change needs it when its app has to reach a destination host over the network and no rule allows that yet.
    steps:
      - Raise a "Network firewall rule" request in the service desk and fill in the source app, destination host, port, protocol and business justification.
      - Follow the request until the network team decides it; the typical lead time is 10 working days, so raise it early.
  - id: gateway-route
    summary: A "Gateway proxy deployment" request asks the gateway team to deploy a gateway proxy. A change needs it when a call has to go through a new gateway proxy that does not exist yet.
    steps:
      - Raise a "Gateway proxy deployment" request in the service desk and fill in the proxy name.
      - Follow the request until the gateway team decides it; the lead time is 3 days, so raise it early.
```


### run-2

```yaml
templates:
  - id: firewall-rule
    summary: A "Network firewall rule" request asks the network team to open the network path an app needs to reach a destination host. A change needs it when it adds a call to a host that no firewall rule covers yet, and the usual lead time is 10 working days.
    steps:
      - Raise a "Network firewall rule" request in the service desk and fill in the source app, destination host, port, protocol and business justification.
      - Follow the request in the service desk until the network team, who approve it, have decided it.
  - id: gateway-route
    summary: A "Gateway proxy deployment" request asks the gateway team to deploy a proxy for a new gateway route. A change needs it when it adds a call that has to go through a new gateway proxy, and the lead time is 3 days.
    steps:
      - Raise a "Gateway proxy deployment" request in the service desk and fill in the proxy name, which is its only field.
      - Follow the request in the service desk until the gateway team, who approve it, have decided it.
```


### run-3

```yaml
templates:
  - id: firewall-rule
    summary: "A Network firewall rule request asks the network team to allow traffic between an app and a destination host. A change needs it when a service has to reach a new host, and it takes about 10 working days, so raise it early."
    steps:
      - "Raise a Network firewall rule request in the service desk and fill in the source app, destination host, port, protocol and business justification."
      - "Follow the request in the service desk until the network team has decided it."
  - id: gateway-route
    summary: "A Gateway proxy deployment request asks the gateway team to deploy a gateway proxy. A change needs it when a service is reached through a new gateway proxy, and it takes about 3 days."
    steps:
      - "Raise a Gateway proxy deployment request in the service desk and fill in the proxy name."
      - "Follow the request in the service desk until the gateway team has decided it."
```


### run-4

```yaml
templates:
  - id: firewall-rule
    summary: "A Network firewall rule request asks the network team to allow traffic from one app to a destination host. A change needs it when an app has to reach a host that the firewall does not yet allow."
    steps:
      - "Raise a \"Network firewall rule\" request in the service desk and fill in the source app, the destination host, the port, the protocol and the business justification."
      - "Follow the request until the network team has decided it, and allow for a lead time of about 10 working days."
  - id: gateway-route
    summary: "A Gateway proxy deployment request asks the gateway team to deploy a proxy. A change needs it when a new gateway proxy has to exist before the change can go live."
    steps:
      - "Raise a \"Gateway proxy deployment\" request in the service desk and fill in the proxy name."
      - "Follow the request until the gateway team has decided it, and allow for a lead time of about 3 days."
```


### run-5

```yaml
templates:
  - id: firewall-rule
    summary: This request asks the network team to open a firewall rule so that one app can reach a destination host. A change needs it when a new call goes to a host that no firewall rule covers yet, and it takes about 10 working days.
    steps:
      - Raise a "Network firewall rule" request in the service desk and fill in the source app, destination host, port, protocol and business justification.
      - Follow the request until the network team, who approve it, have decided.
  - id: gateway-route
    summary: This request asks the gateway team to deploy a gateway proxy. A change needs it when a new call has to go through a gateway proxy that is not deployed yet, and it takes about 3 days.
    steps:
      - Raise a "Gateway proxy deployment" request in the service desk and fill in the proxy name.
      - Follow the request until the gateway team, who approve it, have decided.
```

