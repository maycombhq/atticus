# The bench

Public open-source repos, each pinned to a commit, with a reference a person wrote by reading the code (not from a scan): what the repo serves, calls, stores and deploys, every fact with `path:line`. `atticus bench` scans each repo with this build of Atticus and scores found, missed and wrong. Revamp plan, Phase 1.

```
atticus bench fetch            # clone each repo at its pinned commit (outside this checkout)
atticus bench run              # adopt and scan each with this Atticus, score it against its reference
atticus bench run --repo eshop --json
```

- `repos.yaml`: the repos, their commits and stacks. Batch 1 is six repos; the rest of the approved list (22 in all) follows.
- `references/<id>.yaml`: the reference. `covers` says which kinds are complete; only those are scored. `notes` records every judgement call.
- Clones and results live in `%LOCALAPPDATA%\atticus\bench` (or `~/.cache/atticus/bench`); results are JSON per run, with what was missed and wrong per kind.

## How facts are compared

- **serves:** `type METHOD /path` for HTTP (paths without host or base, parameters as `{}`, no letter case), `grpc package.Service/Method`, `soap Contract/Operation`, `event-topic Name` for a topic or event the repo listens to. A route with no method (or ANY) matches any method on the same path.
- **calls:** the same for outbound calls, plus `event Name` for events published.
- **stores:** table names, without schema or letter case.
- **deploys:** the platform a workload runs on (kubernetes, cloud-run, azure-container-apps, service-fabric...). Helm, Kustomize and Terraform are tooling, not platforms.

Facts are compared as one set per repo, so the same route in two apps of one repo counts once. Found means in both; missed means in the reference only; wrong means in the scan only, for kinds the reference covers.

## Baseline: today's built-in readers (2026-10-21, batch 1)

| Repo                     |   Found |  Missed |  Wrong | Precision |  Recall |
| ------------------------ | ------: | ------: | -----: | --------: | ------: |
| spring-petclinic         |      24 |       1 |      0 |      100% |     96% |
| spring-petclinic-rest    |       8 |      38 |     38 |       17% |     17% |
| spring-petclinic-angular |       0 |      30 |      7 |        0% |      0% |
| eshop                    |      42 |      80 |      9 |       82% |     34% |
| eshop-modernizing        |       9 |      46 |      3 |       75% |     16% |
| microservices-demo       |      20 |      31 |     13 |       61% |     39% |
| **All**                  | **103** | **226** | **70** |   **60%** | **31%** |

Only the plain Spring monolith reads well. What the misses and wrong facts come from:

1. **Path prefixes ignored.** A context path in config (`server.servlet.context-path`) and class-level prefixes are dropped, so every endpoint of the petclinic REST API is reported at the wrong path: each counts once as missed and once as wrong.
2. **Base URLs not resolved in clients.** The Angular app builds every URL as `environment.REST_API_URL + 'owners'`; none of its 30 calls is found. eShop's clients lose the `/api` prefix the same way.
3. **Generated folders scanned.** The Angular repo's `docs/` (a generated documentation app) gives 7 calls the product never makes.
4. **Events not read.** eShop's 18 RabbitMQ subscriptions and 13 published integration events are almost all missed.
5. **gRPC clients not followed.** In microservices-demo 15 of 16 gRPC calls between services are missed, though the servers are found.
6. **WCF client calls missed**, and most legacy MVC and WebForms routes (conventional routing, `.aspx` pages).
7. **Tables named by convention missed:** a JPA `@JoinTable`, EF 6 pluralised names, the ASP.NET Identity tables a library creates, tables in Spanner and AlloyDB setup scripts.
8. **Platforms not known:** Azure Container Apps (from the .NET Aspire host), Service Fabric, Azure Container Instances.
9. **Go routes misread:** the frontend's routes come out as `ANY /{}/...` with a stray prefix.

These are the kinds of gap ADR 0074 expects: each needs a reader change today. Phase 2a's AI-first scan is measured against this table.
