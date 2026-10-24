# The map of forge-ledger

<!-- Rendered by atticus map render forge-ledger from the catalog and its specs (ADR 0124). Don't edit: correct the facts and run atticus verify forge-ledger --write. -->

**Trust:** 17 facts verified on their lines; coverage 92% of source files (1 unknown file: cited by no fact and opened through no Atticus tool); 0 rejected. Commit 0123abc.

## What it serves

### ledger-api

- `GET /accounts/{accountId}` (rest; auth oauth2): [src/main/java/forge/ledger/AccountController.java:18](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/AccountController.java#L18)
- `POST /accounts/{accountId}/entries` (rest; request: amount, currency): [src/main/java/forge/ledger/EntryController.java:22](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/EntryController.java#L22)
- `forge.payments.settled` (event-topic): [src/main/java/forge/ledger/SettlementListener.java:14](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/SettlementListener.java#L14)

## What it calls

### northwind-fx (Northwind FX, vendor)

- `GET /v1/rates/{}` (from ledger-api; sync; via direct; sends pair): [src/main/java/forge/ledger/FxClient.java:31](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/FxClient.java#L31)

### Not joined yet

- `POST http://notify.internal/notify` (from ledger-api; http-call): [src/main/java/forge/ledger/Notifier.java:9](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/Notifier.java#L9). Asked: [Which repo answers on notify.internal?](../../questions/q-53bbda8a5c5f.yaml)

## What it stores

### ledger-db (relational)

- `account` (table; read by ledger-api): [src/main/java/forge/ledger/AccountRepository.java:12](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/AccountRepository.java#L12)
- `entry` (table; written by ledger-api): [src/main/java/forge/ledger/EntryRepository.java:8](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/EntryRepository.java#L8)
  - `account_id` (bigint; not null; internal): [src/main/resources/db/migration/V2__create_entry.sql:3](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/resources/db/migration/V2__create_entry.sql#L3)
  - `amount` (numeric(18,2); not null; confidential): [src/main/resources/db/migration/V2__create_entry.sql:4](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/resources/db/migration/V2__create_entry.sql#L4)

## Where it runs

- `ledger-api` on kubernetes (env prod; 3 replicas): [k8s/ledger-api.yaml:7](https://git.forge.example/forge/forge-ledger/blob/0123abc/k8s/ledger-api.yaml#L7)

## Config that names other systems

- `fx.client.base-url = https://fx.northwind.example/api` (config; in ledger-api; for northwind-fx): [src/main/resources/application.yml:12](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/resources/application.yml#L12)
- `fx.client.read-timeout = 1500ms` (timeout; in ledger-api; for northwind-fx): [src/main/resources/application.yml:13](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/resources/application.yml#L13)

## Flows

- [Post a ledger entry](flows/ledger-api.post-a-ledger-entry.md) (starts at `POST /accounts/{accountId}/entries`; 4 steps; 1 error path): [src/main/java/forge/ledger/EntryController.java:22](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/EntryController.java#L22)

## Contracts

- [ledger-api.openapi.yaml](contracts/ledger-api.openapi.yaml): OpenAPI 3.1, 2 REST entries of ledger-api

Events (listed here; no AsyncAPI file is written):

- `forge.payments.settled` (event-topic, listened to by ledger-api): [src/main/java/forge/ledger/SettlementListener.java:14](https://git.forge.example/forge/forge-ledger/blob/0123abc/src/main/java/forge/ledger/SettlementListener.java#L14)

## Open questions

- [Which repo answers on notify.internal?](../../questions/q-53bbda8a5c5f.yaml): cites `src/main/java/forge/ledger/Notifier.java:9`
