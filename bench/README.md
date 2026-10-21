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

## Baseline: today's built-in readers (2026-10-21, all 22 repos)

| Repo                           |   Found |  Missed |   Wrong | Precision |  Recall |
| ------------------------------ | ------: | ------: | ------: | --------: | ------: |
| spring-petclinic               |      24 |       1 |       0 |      100% |     96% |
| spring-petclinic-rest          |       8 |      38 |      38 |       17% |     17% |
| spring-petclinic-angular       |       0 |      30 |       7 |        0% |      0% |
| spring-petclinic-microservices |      30 |      17 |       4 |       88% |     64% |
| piggymetrics                   |       4 |      25 |       9 |       31% |     14% |
| spring-realworld               |      26 |      18 |      18 |       59% |     59% |
| spring-soap                    |       0 |       1 |       0 |      100% |      0% |
| jenkins-maven                  |       0 |       0 |       0 |      100% |    100% |
| eshop                          |      42 |      80 |       9 |       82% |     34% |
| eshop-modernizing              |       9 |      46 |       3 |       75% |     16% |
| eshop-on-web                   |      18 |      61 |      29 |       38% |     23% |
| clean-architecture             |       2 |      28 |       1 |       67% |      7% |
| todo-csharp-sql                |      12 |      12 |       2 |       86% |     50% |
| angular-realworld              |       0 |      19 |       0 |      100% |      0% |
| bulletproof-react              |       0 |      32 |       0 |      100% |      0% |
| node-realworld                 |       5 |      22 |      19 |       21% |     19% |
| nestjs-realworld               |      21 |       6 |       0 |      100% |     78% |
| todo-nodejs-mongo              |      12 |      14 |       0 |      100% |     46% |
| fastapi-template               |       0 |      43 |      23 |        0% |      0% |
| fastapi-realworld              |       0 |      27 |      19 |        0% |      0% |
| microservices-demo             |      20 |      31 |      13 |       61% |     39% |
| podinfo                        |      36 |      12 |       1 |       97% |     75% |
| **All**                        | **269** | **563** | **195** |   **58%** | **32%** |

(Batch 1 alone: 60% precision, 31% recall.) Precision of 100% with low recall means the readers found little but nothing false; a repo with nothing to find (jenkins-maven) scores 100% on both.

What the misses and wrong facts come from, biggest first:

1. **Path prefixes dropped, in every stack.** Spring's context path and class-level prefixes, Express router prefixes, FastAPI's API prefix from settings, ASP.NET's route-token conventions. The endpoints are found but at the wrong path, so each counts once as missed and once as wrong: this alone explains most of the wrong facts and the zeros of both FastAPI repos and node-realworld.
2. **Client calls not found.** Base URLs from environment files, interceptors and generated clients aren't resolved: no call is found in any of the four front ends (petclinic Angular, angular-realworld, bulletproof-react, the fastapi-template front end).
3. **Gateway routes missed.** Zuul and Spring Cloud Gateway route predicates (`/accounts/**`).
4. **Generated folders scanned.** The petclinic Angular repo's `docs/` gives 7 calls the product never makes.
5. **Events not read.** eShop's 18 RabbitMQ subscriptions and 13 published integration events are almost all missed.
6. **gRPC clients not followed.** In microservices-demo 15 of 16 calls between services are missed, though the servers are found.
7. **Legacy .NET:** WCF client calls, conventional MVC routes and WebForms pages mostly missed.
8. **Tables named by convention:** a JPA `@JoinTable`, EF pluralised names, ASP.NET Identity tables, Prisma's hidden join tables, Spanner and AlloyDB setup scripts.
9. **Platforms not known:** Azure Container Apps (from a .NET Aspire host), Service Fabric, Azure Container Instances.
10. **SOAP operations and GraphQL fields** (spring-soap, spring-realworld) not read.

These are the kinds of gap ADR 0074 expects: each needs a reader change today. Phase 2a's AI-first scan is measured against this table.

## With the AI's scan settings (Phase 2a, first step)

`atticus bench survey` has the assistant read each repo and draft its scan settings (ADR 0075): the path prefixes the readers can't see and the folders that aren't the product, every entry checked against the code. `atticus bench run` then scans with them. All 22 repos surveyed with headless Claude Code, one run each of about 30 seconds; the assistant judged 11 to need no settings.

|                             | Found | Missed | Wrong | Precision | Recall |
| --------------------------- | ----: | -----: | ----: | --------: | -----: |
| Built-in readers alone      |   269 |    563 |   195 |       58% |    32% |
| With the AI's scan settings |   378 |    454 |    81 |       82% |    45% |

### With client base URLs too (ADR 0076)

The front ends re-surveyed with client bases (calls built from a configured base URL), 21 repos (eShopModernizing's clone was removed to free disk; its scores are unchanged by this step):

|                                         | Found | Missed | Wrong | Precision | Recall |
| --------------------------------------- | ----: | -----: | ----: | --------: | -----: |
| With prefixes, folders and client bases |   451 |    326 |    76 |       86% |    58% |

The four front ends that found no calls before: spring-petclinic-angular 30 of 30, bulletproof-react 32 of 32, angular-realworld 18 of 19 (all 0 wrong); fastapi-template's front end uses a generated client and is still missed.

Biggest gains of the first step: spring-petclinic-rest 17% to 98% (precision and recall), fastapi-realworld 0% to 100% precision and 70% recall, node-realworld 21% to 100% and 89%, fastapi-template 0% to 100% and 53%, piggymetrics 31% to 100% and 14% to 52%; the Angular repo's generated `docs/` is no longer read (7 wrong calls gone).

Still missed: front-end calls (none found in four UI repos: client base URLs come next), events and gRPC clients, conventional and legacy .NET routes, convention-named tables, some platforms. Wrong: spring-realworld and eshop-on-web route conventions the settings can't express yet.
