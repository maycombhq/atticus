# Gateway forwards a card lock

## Tasks

### Task 2.1: Add the entry step: Matches PUT /cards/*/lock in a new LockCard flow, and 1 more step in default.xml

- Step: add (entry), item 1 of target-flows/proxy-core-v1.lock-card.yaml: Matches PUT /cards/*/lock in a new LockCard flow
- Step: add (call-out), item 2 of target-flows/proxy-core-v1.lock-card.yaml: Forwards the lock to the card vault through core-backend; goes to card-vault PUT /cards/{id}/lock (new)
