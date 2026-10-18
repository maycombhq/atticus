# Harbor integration patterns

Every arrow on a Harbor diagram and every hop in a design names one of these codes. Ask in #harbor-architecture before inventing a new one.

| Pattern | Title | Style | Route | Target | Controls | Tech |
| --- | --- | --- | --- | --- | --- | --- |
| HB.GQL.CLIENT | Client app to the Shop Graph | sync | direct | product | Customer session token, persisted queries only | GraphQL |
| HB.SYNC.MESH | Service to service through the mesh | sync | mesh sidecar | product | mTLS from the mesh, VirtualService for the callee, timeout under 2 s | Istio, REST, gRPC |
| HB.ASYNC.EVENT | Domain event on Kafka | async | Kafka event bus | product | AsyncAPI document, schema in the registry, idempotent consumer | Kafka, AsyncAPI |
| HB.VND.EGRESS | SaaS vendor call through the egress gateway | sync | egress gateway | vendor | Egress allow-list, timeout, retry with idempotency key | Istio egress gateway |
| HB.VND.HOOK | Vendor webhook into a function | sync | vendor callback | product (function) | Signature check, replay window, dead-letter queue | AWS Lambda, Serverless Framework |
| HB.DATA.ELT | Service tables into the warehouse | data-access | read replica (database) | data store | Read replica only, column allow-list, owner approval | Airflow, dbt |
| HB.DATA.FEAT | Model features from the warehouse | data-access | warehouse table | data store | Feature view in the feature repo, freshness under 2 days | Feast |
