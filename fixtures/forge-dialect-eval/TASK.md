# Task: write the forge-messaging dialect

You are working in a folder that holds:

- `kit/`: the Atticus dialect build kit. Start with `kit/README.md`; the kit is all the documentation there is.
- `repos/`: three repositories built on **Forge Messaging**, an in-house messaging framework: `repos/order-intake`, `repos/inventory-sync` and `repos/notify-worker`.
- `org-pack/dialects/`: where your dialect goes.

Run every `atticus` command from this folder (the one holding `TASK.md`).

## What to write

One dialect file, `org-pack/dialects/forge-messaging.yaml`, with `name: forge-messaging`, that teaches the Atticus scanner Forge Messaging, with its own tests. It is done when `atticus dialect test forge-messaging` passes and running it over each repo produces exactly the records listed below.

The dialect must describe the framework, not these three repos: other Forge Messaging apps will be scanned with it, so take names, channels, queues, routes and values from the source files, never write them into rules.

## What Forge Messaging apps look like

Every Forge Messaging app has a descriptor file at its root that names the app; that name is the component for every record the app produces. Survey the repos to find it (`atticus dialect new` helps).

From each app, the catalog needs:

1. **Queues it consumes.** Each method that consumes a message queue serves an endpoint of type `mq-queue`, owned by the app. The endpoint's `pathOrTopic` is the queue name exactly as written; its id is `<app>.queue.<queue name in lowercase>`. Confidence `verified`.
2. **Requests it makes.** Each method of a relay client interface makes a direct, synchronous request from the app to the service the client targets: an `Interface` with `via: direct` and `sync: sync`, the HTTP method in upper case and the route as its normalised path. Interface ids are derived by Atticus. Confidence `inferred` (only the caller's side is seen).
3. **Channels it publishes to and consumes from.** Each is a loose end the scanner resolves later: an `Unresolved` record owned by the app, following the loose-end conventions in the kit, with the channel name as `raw`. Ids are `<app>.publish.<channel>` and `<app>.subscribe.<channel>`. Confidence `inferred`.
4. **Relay client timeouts.** Each `relay.clients.<client>.timeout` key in the app's `src/main/resources/application.yml` is a `Setting` of kind `timeout`, owned by the app, whose `key` is the full key and whose `valueOrRef` is the value. Its id is `<app>.<client>.timeout`. Other keys are not settings. Confidence `verified`.

Only production code counts: files under `src/main/java`. Test code under `src/test/java`, and anything commented out, must not produce records.

## Expected records

The dialect must produce these records, with these field values, and no other `Endpoint`, `Interface`, `Unresolved` or `Setting` records. Other fields may be set as well.

### repos/order-intake

| kind | id | fields |
| --- | --- | --- |
| Endpoint | `order-intake.queue.orders.in` | component `order-intake`, endpointType `mq-queue`, pathOrTopic `ORDERS.IN`, confidence `verified` |
| Interface | `if-388dac6b99d62ee6` | from `order-intake`, to `inventory-api`, via `direct`, method `GET`, normalizedPath `/stock/{}`, sync `sync`, confidence `inferred` |
| Interface | `if-39f6d71491016a72` | from `order-intake`, to `inventory-api`, via `direct`, method `POST`, normalizedPath `/reservations`, sync `sync`, confidence `inferred` |
| Unresolved | `order-intake.publish.orders.received` | unresolvedKind `event-publish`, raw `orders.received`, owner `order-intake`, confidence `inferred` |
| Unresolved | `order-intake.subscribe.payments.settled` | unresolvedKind `event-subscribe`, raw `payments.settled`, owner `order-intake`, confidence `inferred` |
| Setting | `order-intake.inventory-api.timeout` | component `order-intake`, settingKind `timeout`, key `relay.clients.inventory-api.timeout`, valueOrRef `2s`, confidence `verified` |

### repos/inventory-sync

| kind | id | fields |
| --- | --- | --- |
| Endpoint | `inventory-sync.queue.stock.adjust` | component `inventory-sync`, endpointType `mq-queue`, pathOrTopic `STOCK.ADJUST`, confidence `verified` |
| Interface | `if-444a80174d7113fb` | from `inventory-sync`, to `warehouse-gateway`, via `direct`, method `PUT`, normalizedPath `/bins/{}`, sync `sync`, confidence `inferred` |
| Interface | `if-a335408ee3c9f01d` | from `inventory-sync`, to `warehouse-gateway`, via `direct`, method `GET`, normalizedPath `/bins/{}/contents`, sync `sync`, confidence `inferred` |
| Unresolved | `inventory-sync.publish.stock.changed` | unresolvedKind `event-publish`, raw `stock.changed`, owner `inventory-sync`, confidence `inferred` |
| Unresolved | `inventory-sync.subscribe.orders.received` | unresolvedKind `event-subscribe`, raw `orders.received`, owner `inventory-sync`, confidence `inferred` |
| Setting | `inventory-sync.warehouse-gateway.timeout` | component `inventory-sync`, settingKind `timeout`, key `relay.clients.warehouse-gateway.timeout`, valueOrRef `5000ms`, confidence `verified` |

### repos/notify-worker

| kind | id | fields |
| --- | --- | --- |
| Endpoint | `notify-worker.queue.notify.retry` | component `notify-worker`, endpointType `mq-queue`, pathOrTopic `NOTIFY.RETRY`, confidence `verified` |
| Unresolved | `notify-worker.publish.notifications.sent` | unresolvedKind `event-publish`, raw `notifications.sent`, owner `notify-worker`, confidence `inferred` |
| Unresolved | `notify-worker.subscribe.orders.received` | unresolvedKind `event-subscribe`, raw `orders.received`, owner `notify-worker`, confidence `inferred` |
| Unresolved | `notify-worker.subscribe.stock.changed` | unresolvedKind `event-subscribe`, raw `stock.changed`, owner `notify-worker`, confidence `inferred` |

## Tests the dialect must ship

The dialect's `tests` must pass with `atticus dialect test forge-messaging`, and must include at least:

- one test over a real repo (a `fixture` path relative to the dialect file, e.g. `../../repos/order-intake`) that checks records of every kind above;
- one test with inline `files` showing that a repo without the descriptor file produces nothing.

## Done when

- `atticus dialect test forge-messaging` passes;
- `atticus dialect run forge-messaging repos/<repo>` prints exactly the records above for each of the three repos (plus nothing else of those kinds);
- you have checked your work against `kit/checklist.md`.
