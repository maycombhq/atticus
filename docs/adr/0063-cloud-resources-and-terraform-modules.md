# 0063. Cloud resources as shipped rule files; Terraform modules followed

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

Atticus read Terraform through a fixed list in code: Cloud Run, Pub/Sub, IAM and Cloud Functions (the gcp and serverless extractors), buckets, SQS, Redshift, BigQuery and ElastiCache (cloud-stores), and databases through a regular expression over the `.tf` text in the infra extractor. Anything else an estate provisions (SNS, Lambda, DynamoDB, Service Bus, function and web apps, API Management, Cosmos DB...) was invisible, and adding it meant a code change, against rule 7 (extension over edits). The regex read only literal values, missed a block whose closing brace wasn't at the start of a line, and took the first `name = ` in the body, nested blocks included.

Estates also wrap resources in their own modules. `module "orders_queue" { source = "../modules/queue" name = "orders" }` provisions a topic named from `var.name`; read folder by folder, the module's resources have no name, and the call has no resources.

## Decision

**Shipped dialects per cloud.** `packages/extractors/dialects/terraform-aws.yaml`, `terraform-azure.yaml` and `terraform-gcp.yaml` map common resource types to C1 records with `hclBlock` rules (ADR 0056, 0058). Each file's header lists what it reads, what it leaves to built-in readers, and what gives no record. They apply to every repo with a `.tf` file: `appliesTo: { repoTypes: ["*"], marker: "**/*.tf" }` (ADR 0062). An org-pack dialect of the same name replaces a shipped one, so an organisation changes the mapping without a code change.

- Topics (SNS, EventBridge buses, Kafka topics, Service Bus topics, event hubs) are `event-topic` Endpoints with component `unknown`, as Pub/Sub topics already are; merge joins them by topic and fills the publisher from the code.
- Queues (Service Bus, Cloud Tasks) are DataStores of type `queue`, as SQS queues already are; DynamoDB `key-value`, Cosmos DB `document`, MSK `stream`, Redis caches `cache`, Spanner `relational`.
- Functions (Lambda, Azure function apps) are a Component of type `function` and a Deployment; ECS services and App Service web apps a Deployment. The environment is the resource's `env` tag, else `default`.
- API Gateway v2 routes and first-level v1 resources, and API Management APIs, are GatewayRoutes (APIM with the ids the APIOps dialect uses).
- **The database reader moves into the dialects.** `google_sql_database_instance`, `aws_db_instance`, `aws_rds_cluster`, `azurerm_postgresql_flexible_server` and `azurerm_mssql_server` give the same DataStores as before (id, store type, evidence file and line), now with values resolved from variables; the infra extractor no longer reads `.tf` files. The engine-to-type mapping is one rule per type with a `where` on the engine.
- **What stays in code**, because a rule can't say it or would give different ids: Cloud Run, Pub/Sub, IAM, Cloud Functions, Cloud Scheduler, SageMaker (environments from folders, owners from labels and push endpoints, triggers), and the cloud-stores resources, whose ids use the platform slug (`_` becomes `-`) that dbt and Feast join on; the template `slug` filter keeps `_`. The dialects skip those types, so no record comes from two places.
- Clusters (EKS, AKS, GKE) give no record: C1 has no kind for where deployments run.

**Contract C2, additions** (optional, ADR 0041's rule; `schemaVersion` stays 1):

- Filters **`before('x')`** and **`after('x')`**: the text before or after the first occurrence of `x`, empty when it isn't there. `${attr.route_key | after(' ')}` is `/orders` for `GET /orders`.
- In an `hclBlock` match, an attribute whose value is an object gives its fields dotted (`${attr.tags.env}`), and an attribute that is a reference to another resource gives that resource as `${attr.<name>.ref}` (`aws_apigatewayv2_api.shop` for `api_id = aws_apigatewayv2_api.shop.id`), so a lookup keyed by `${match.1}.${match.0}` reads the referenced resource's attributes.

**Local modules are followed** (engine, no syntax change). The Terraform loader used by the built-in readers and by `hclBlock` matches treats a `module` block whose `source` is a folder of the repo (`./x`, `../modules/queue`) as an instance of that folder: its variables take the values the caller passes, resolved in the caller, over the module's defaults. Each instantiation is read separately, nested modules included (up to eight deep; a cycle stops). A folder that some folder calls is read only through its instances, not on its own with its defaults. A value the caller can't resolve (another module's output, a data source) stays unknown inside the module: the resources that need it are skipped, and a resource's label (`this`) is not used as its name. Remote sources (registry, `git::`, URLs) stay `module` blocks a dialect matches, as before. Repos without local modules read exactly as before.

## Consequences

- The common AWS, Azure and Google Cloud resources are read with no org-pack work, and an organisation corrects or extends the mapping in a rule file.
- A module instance's records cite the resource in the module's folder, so two instantiations cite the same line with different names.
- Not read yet: Lambda triggers (event source mappings, permissions), API Gateway integrations and nested REST resources, EventBridge rules, module outputs, `count` and `for_each` (a resource with them is read once). A Deployment's replica count needs numeric template fields, which C2 doesn't have.
- Each scan runs the three dialects' own tests, as for every shipped dialect.
