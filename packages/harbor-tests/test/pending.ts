/**
 * Records in fixtures/harbor/expected/scan.yaml that need a producer this main doesn't have
 * yet, grouped by the producer. The scan test compares every other record field for field
 * and skips each group (`it.skip`) with the producer's name; when the producer lands, the
 * lead removes its group from SKIPPED in scan.test.ts and the comparison runs.
 *
 * Keys are "<kind>/<id>". A record needing two producers sits in the group that lands last.
 * `extraOnMain` lists records today's main makes in their place (to be gone once it lands).
 */
export interface PendingGroup {
  producer: string;
  records: string[];
  extraOnMain?: string[];
}

export const PENDING: Record<string, PendingGroup> = {
  graphql: {
    producer:
      "GraphQL extractor (ADR 0040): SDL root fields as graphql endpoints, client operations as calls",
    records: [
      "Endpoint/shop-graph.query-products",
      "Endpoint/shop-graph.query-product",
      "Endpoint/shop-graph.query-order",
      "Endpoint/shop-graph.query-recommendations",
      "Endpoint/shop-graph.mutation-place-order",
      "Interface/if-48178a435150f443",
      "Interface/if-d9b83070fa73af6e",
      "Interface/if-95c398a68099a3e5",
      "Interface/if-9e795e3899379f37",
      "Interface/if-924d2e2fb35e1629",
      "Interface/if-d35e619ee1aa530d",
      "Interface/if-18efeccc7ba574be",
    ],
  },
  grpc: {
    producer:
      "gRPC extractor (ADR 0040): .proto services as grpc endpoints, client stubs as calls (through the mesh)",
    records: [
      "Endpoint/catalog-svc.check-stock",
      "Endpoint/catalog-svc.reserve-stock",
      "Interface/if-307343928186de57",
    ],
  },
  mesh: {
    producer:
      "service mesh extractor (ADR 0040): a call to a host with an Istio VirtualService is via mesh",
    records: [
      "Interface/if-46861c9fa2695f99",
      "Interface/if-6394ddc280a46330",
      "Interface/if-2fade641225c4539",
      "Interface/if-f571ccbd0ee1281d",
      "Interface/if-a24c46bb442ec4b3",
    ],
  },
  ingress: {
    producer:
      "ingress extractor (ADR 0040): Deployment.ingress from an Istio Gateway and the VirtualServices bound to it",
    records: ["Deployment/shop-graph.prod", "Deployment/orders-svc.prod"],
  },
  serverless: {
    producer:
      "serverless extractor (ADR 0040): serverless.yml webhook and function endpoints, schedules (settingKind schedule) and aws-lambda Deployments",
    records: [
      "Endpoint/payment-webhook.post-tidewater",
      "Endpoint/cart-reminder.remind-abandoned-carts",
      "Deployment/payment-webhook.prod",
      "Deployment/cart-reminder.prod",
      "Setting/cart-reminder.schedule-remindabandonedcarts",
      "Component/payment-webhook",
      "Component/cart-reminder",
    ],
  },
  webhooks: {
    producer:
      "webhook interfaces (ADR 0040): a partner spec's webhooks section to the function serving it, via webhook",
    records: ["Interface/if-471a26719fe84220"],
  },
  "function-events": {
    producer:
      "event publishes in function code: kafkajs in a package with no server framework (the Node extractor reads server packages only)",
    records: ["Interface/if-9c9b1e808fbaac38"],
  },
  "ml-models": {
    producer:
      "ML model extractor (ADR 0040): a KServe InferenceService's predict endpoint and Deployment",
    records: [
      "Endpoint/recs-model.post-recommendations-predict",
      "Deployment/recs-model.prod",
      "Component/recs-model",
      "Interface/if-9c51c4944979e455",
    ],
  },
  "data-pipelines": {
    producer:
      "data pipeline extractor (ADR 0040): Airflow schedules, dbt models as warehouse tables, dbt sources as readers of service tables",
    records: [
      "DataStore/harbor-warehouse",
      "Table/harbor-warehouse.stg-orders",
      "Table/harbor-warehouse.stg-products",
      "Table/harbor-warehouse.fct-daily-sales",
      "Setting/warehouse-pipeline.schedule-orders-daily",
      "Table/catalog-db.products",
      "Table/orders-db.orders",
    ],
  },
  "feature-store": {
    producer:
      "feature store extractor (ADR 0040, with the data pipeline one): Feast online store, feature views, RedshiftSource readers",
    records: [
      "DataStore/harbor-features",
      "Table/harbor-features.customer-features",
      "Table/harbor-warehouse.customer-features",
    ],
  },
  "cloud-stores": {
    producer:
      "Terraform object storage and queues as DataStores (ADR 0040 storeType object-storage, queue); infra reads databases only",
    records: ["DataStore/harbor-media", "DataStore/harbor-webhook-dlq"],
  },
  saas: {
    producer: "SaaS vendor systems tagged saas (ADR 0040 System tags convention)",
    records: ["System/tidewater-payments", "System/lantern-mail"],
  },
  "vendor-hosts": {
    producer:
      "merge resolving a vendor host (api.tidewater.example, api.lanternmail.example) through the profile alias or the partner spec's servers; no lane owns this yet",
    records: [
      "Interface/if-a4ccfcea11eeebf0",
      "Interface/if-018d1416ec04a61a",
      "Interface/if-10465a7b9c85231e",
    ],
  },
  "golang-migrate": {
    producer:
      "migrations extractor reading golang-migrate names (<version>_<name>.up.sql); it knows Flyway's V<n>__ only; no lane owns this yet",
    records: ["Migration/catalog-db.v0001", "Migration/catalog-db.v0002"],
    extraOnMain: [
      "Migration/catalog-db.v0001-create-products.up",
      "Migration/catalog-db.v0002-create-stock-levels.up",
    ],
  },
};

export const pendingKeys = (groups = Object.keys(PENDING)): Set<string> =>
  new Set(groups.flatMap((g) => PENDING[g]!.records));
