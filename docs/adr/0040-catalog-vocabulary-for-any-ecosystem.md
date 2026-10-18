# 0040. Catalog vocabulary for any ecosystem (C1 version 2 additions)

- Status: accepted (ADR 0035 point 2)
- Date: 2026-10-18

## Decision

Catalog schema version 2 (ADR 0031) has not been released, so these additive values and optional fields join version 2 with no further bump; version-1 files still read unchanged.

| Where                   | Addition                            | Meaning                                                                                                                                                                                   |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Endpoint.endpointType` | `graphql`                           | a GraphQL operation; `method` is `QUERY`, `MUTATION` or `SUBSCRIPTION`, `pathOrTopic` the field name (`Query.account`)                                                                    |
|                         | `websocket`, `sse`                  | a WebSocket or server-sent-events endpoint; `pathOrTopic` is the path                                                                                                                     |
|                         | `webhook`                           | an endpoint that receives callbacks from another system                                                                                                                                   |
|                         | `function`                          | a serverless or scheduled function's trigger (`pathOrTopic` names the trigger)                                                                                                            |
|                         | `transaction`                       | an online transaction in a transaction monitor (for example CICS); `pathOrTopic` is the transaction id                                                                                    |
| `Interface.via`         | `mesh`                              | a call through a service mesh sidecar                                                                                                                                                     |
|                         | `webhook`                           | a callback registered with another system                                                                                                                                                 |
| `Setting.settingKind`   | `schedule`                          | a cron or rate schedule (replaces the `config` + `schedule.` key convention of ADR 0024, which stays readable)                                                                            |
| `Deployment`            | `ingress?: { host, path?, tls? }[]` | public or internal routes to the deployment (replaces the `route.<name>` Setting convention of ADR 0024)                                                                                  |
| `DataStore.storeType`   | documented values                   | `relational`, `document`, `key-value`, `cache`, `warehouse`, `lake`, `object-storage`, `search`, `feature-store`, `queue`, `stream`, `file-share` (free text stays allowed)               |
| `Component.type`        | documented values                   | `service`, `spa`, `bff`, `mobile-app`, `desktop-app`, `function`, `batch-job`, `data-pipeline`, `ml-model`, `gateway`, `worker`, `library`, `mainframe-program` (free text stays allowed) |
| `System`                | `tags` convention `saas`            | a SaaS product used as a system (boundary `vendor`)                                                                                                                                       |

Data movement stays first-class through existing kinds: file transfers are Interfaces `via: sftp` to `file-drop` endpoints; pipelines are Components (`data-pipeline`) with table readers and writers on DataStores (`warehouse`, `lake`); ML models are Components (`ml-model`) reading a `feature-store`.

Each addition ships with an extractor or dialect rule that produces it and a golden test, and existing extractors that used the older conventions (schedules as `config` Settings, OpenShift routes as Settings, CICS transactions as Settings) move to the new values, keeping their ids.

## Consequences

The catalog describes web, mobile, event, serverless, mesh, data and mainframe estates without stretching fields. The second reference ecosystem (Harbor, ADR 0035) is written against this vocabulary.
