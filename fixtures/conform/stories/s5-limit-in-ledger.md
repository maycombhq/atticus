# Story s5-limit-in-ledger: A client creates a transfer

Written by hand in the stories stage's layout (ADR 0087) for the conformance tests (ADR 0114):
each task names the step of the target flow it builds.

## Traces to

target-flows/ledger-api.create-transfer.yaml (modify flow ledger-api.create-transfer: A client creates a transfer)

## Systems and repos

forge-ledger

## Tasks

### Task 1.1: Add the lookup step: The account's daily limit is read

- Step: add (lookup), item 1 of target-flows/ledger-api.create-transfer.yaml
- Store: ledger-db.account: daily_limit

### Task 1.2: Add the branch step: A transfer over the limit is refused with 422 and nothing is posted

- Step: add (branch), item 3 of target-flows/ledger-api.create-transfer.yaml
- Step: remove (call-out), item 4 of target-flows/ledger-api.create-transfer.yaml

### Task 1.3: Add the call-out step: Northwind Pay's velocity check scores the transfer

- Step: add (call-out), item 2 of target-flows/ledger-api.create-transfer.yaml
- Goes to: northwind-pay POST /v2/velocity-checks (new)
