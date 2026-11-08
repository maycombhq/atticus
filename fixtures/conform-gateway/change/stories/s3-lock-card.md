# A teller locks a card

## Tasks

### Task 3.1: Add the entry step: The teller picks the customer's card and asks to lock it, and 1 more step in TellerClient.java

- Step: add (entry), item 1 of target-flows/teller-app.lock-card.yaml: The teller picks the customer's card and asks to lock it
- Step: add (call-out), item 2 of target-flows/teller-app.lock-card.yaml: Calls the core gateway to lock the card; goes to proxy-core-v1 PUT /forge/core/v1/cards/{id}/lock (new)
