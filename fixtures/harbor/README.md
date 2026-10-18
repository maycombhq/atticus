# Harbor: the second reference ecosystem

Everything here is made up. Harbor is an invented online retailer; Tidewater Payments and Lantern Mail are invented SaaS vendors. Harbor is deliberately unlike Forge (ADR 0035 point 3): Node, Python and Go services instead of Java, a GraphQL backend-for-frontend instead of an API gateway, gRPC and Kafka between services, an Istio service mesh on Kubernetes in a public cloud, serverless functions, a mobile app, a data pipeline into a warehouse, a model reading a feature store, Jira and GitHub instead of ADO and ServiceNow. Every stage exit measured on Forge is also measured here, so nothing passes only because it fits one shape. `packages/harbor-tests` runs the pipeline on it.

| Folder | What it holds |
| --- | --- |
| `repos/harbor-web` | React SPA: GraphQL operations sent to the Shop Graph over `/graphql` |
| `repos/harbor-mobile` | React Native app: GraphQL operations to the public API host |
| `repos/harbor-graph` | Shop Graph (Fastify + mercurius): the SDL schema, resolvers calling Catalog, Orders and the model |
| `repos/harbor-catalog` | Go (chi) catalog: REST products, the gRPC Inventory service (`.proto`), a Kafka consumer, golang-migrate migrations |
| `repos/harbor-orders` | NestJS orders: REST, a gRPC client (with a copied `.proto` that must not make it a server), kafkajs, Prisma, an AsyncAPI document, a call to an unknown fraud service |
| `repos/harbor-payments` | FastAPI payments: calls Tidewater; publishes through Harbor's in-house outbox library (the `harbor-outbox` dialect) |
| `repos/harbor-payment-webhook` | Serverless function (Node) receiving Tidewater's webhook and publishing to Kafka; AsyncAPI document |
| `repos/harbor-cart-reminder` | Scheduled serverless function (Python) calling Orders through the internal ingress and Lantern Mail |
| `repos/harbor-data` | Airflow DAG and dbt models reading service tables into the warehouse |
| `repos/harbor-recs` | KServe InferenceService and Feast feature repo for the recommendations model |
| `repos/harbor-platform` | Kubernetes Deployments, Istio Gateway and VirtualServices, Terraform (Postgres, Redshift, S3, SQS, Redis), Prometheus rules and a Grafana dashboard |
| `metarepo/org-pack/` | Profile and repo manifest, Harbor's own pattern codes (HB.*), the harbor-outbox dialect, a checklist, gates, roles, sources and runtime (manual Jira work tracker, GitHub) |
| `inputs/` | A Mermaid architecture diagram and a draw.io data-platform diagram, wiki pages, Tidewater's OpenAPI spec in two versions, Jira and GitHub issue exports |
| `change/openspec/changes/add-gift-cards/` | A seeded change at the plan phase for the critic |
| `expected/scan.yaml` | The catalog a correct scan must produce, in the ADR 0040 vocabulary |
| `expected/inputs.yaml` | What a correct read of the diagrams, documents and inputs must produce |
| `expected/discrepancies.yaml` | Twenty-one seeded problems for reconcile, the critic, knowledge gaps and intake |
| `expected/features.yaml` | Which entry points form one feature (ADR 0031) |

Conventions this fixture fixes, for the producers still to come (lead review):

- A call is `via: mesh` when its target host has an Istio VirtualService; the cart reminder calls Orders through the internal ingress host, so it is `direct`, and so is the call to the model, which has no VirtualService.
- GraphQL endpoints are `<component>.<query|mutation>-<field slug>`, method `QUERY` or `MUTATION`, `pathOrTopic` `Query.<field>`; the caller line of a call is the root field in the operation document; the SDL line is the definition.
- gRPC endpoints are `<component>.<method slug>`, `pathOrTopic` `/<package>.<Service>/<Method>`, no method; the proto's `rpc` line is the definition.
- A webhook receiver is `<component>.post-<last segment>` with endpointType `webhook`; the vendor's spec `webhooks:` entry is the caller end. A scheduled function's trigger is an endpointType `function` named by the function; its schedule is a `settingKind: schedule` Setting named as the batch extractor names schedules (`<component>.schedule-<slug>`, key `schedule.<name>`).
- Ingress routes come from a Gateway-bound VirtualService: host, the URI prefix as path, and tls when the Gateway server has tls.

Rules: the expected files are written by hand and reviewed by a person; never regenerate them from extractor output. Files under `fixtures/` are byte-exact (excluded from formatting) because evidence points at line numbers and documents are hashed.
