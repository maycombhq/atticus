# Forge: the invented test ecosystem

Everything here is made up. Forge is an invented company and an invented in-house framework (`@ForgeService`, `@ForgeEndpoint`, `@ForgeClient`, ...); Northwind Pay is an invented vendor. Every stage of the Atticus build is tested against this ecosystem, because its correct answers are known in advance.

| Folder | What it holds |
| --- | --- |
| `repos/forge-portal-ui` | A TypeScript SPA calling its BFF |
| `repos/forge-portal-bff` | Plain Spring Boot: a controller, a Feign client through the gateway, a direct REST call, a Kafka publish, timeouts in config |
| `repos/forge-ledger` | A service on the invented Forge framework: endpoints, a vendor client, event subscribe and publish, Flyway migrations, an OpenAPI spec |
| `repos/forge-reports-job` | A batch job that reads the ledger's table directly and listens to an event |
| `repos/forge-gateway` | A gateway proxy bundle (Apigee-style XML) with OAuth and spike-arrest policies |
| `repos/forge-events` | Topic definitions with producers and consumers |
| `repos/forge-infra` | Kubernetes deployments, Terraform for the database, alerts as code |
| `inputs/` | The architect's draw.io diagram, wiki pages, a partner spec and sample ticket exports |
| `expected/scan.yaml` | The catalog a correct scan must produce |
| `expected/inputs.yaml` | What a correct read of the diagram and documents must produce |
| `expected/discrepancies.yaml` | Thirteen seeded problems that reconcile, the critic, intake and knowledge-gap checks must each find |

Rules: the expected files are written by hand and reviewed by a person; never regenerate them from extractor output. Files under `fixtures/` are byte-exact (excluded from formatting) because evidence points at line numbers and documents are hashed.
