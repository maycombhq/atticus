# The bench

Public open-source repos, each pinned to a commit, with a reference a person wrote by reading the code (not from a scan): what the repo serves, calls, stores and deploys, every fact with `path:line`. `atticus bench` scans each repo with this build of Atticus and scores found, missed and wrong. Revamp plan, Phase 1.

```
atticus bench fetch            # clone each repo at its pinned commit (outside this checkout)
atticus bench run              # adopt and scan each with this Atticus, score it against its reference
atticus bench run --repo eshop --json
atticus bench facts podinfo --facts podinfo.jsonl   # score an assistant's facts file (ADR 0124) the same way
atticus bench stories --draft story.yaml            # score a drafted user story against stories/
```

- `repos.yaml`: the repos, their commits and stacks. Batch 1 is six repos; the rest of the approved list (22 in all) follows.
- `references/<id>.yaml`: the reference. `covers` says which kinds are complete; only those are scored. `notes` records every judgement call; `ignore` lists true facts outside a kind's scope (a logging level is config, but not config that names another system), which are neither found nor wrong.
- `stories/`: the stories bench (Phase B): `rubric.md` and three reference stories.
- Clones and results live in `%LOCALAPPDATA%\atticus\bench` (or `~/.cache/atticus/bench`); results are JSON per run, with what was missed and wrong per kind.

## How facts are compared

- **serves:** `type METHOD /path` for HTTP (paths without host or base, parameters as `{}`, no letter case), `grpc package.Service/Method`, `soap Contract/Operation`, `event-topic Name` for a topic or event the repo listens to. A route with no method (or ANY) matches any method on the same path.
- **calls:** the same for outbound calls, plus `event Name` for events published.
- **stores:** table names, without schema or letter case.
- **deploys:** the platform a workload runs on (kubernetes, cloud-run, azure-container-apps, service-fabric...). Helm, Kustomize and Terraform are tooling, not platforms.
- **fields** (five references, ADR 0124 §6): `entry <serves fact> | <side> <name>` for a top-level field of an entry's success request or response body (query parameters are request fields, path parameters are part of the path), `call <calls fact> | <side> <name>` for a call's, and `column <table> | <name>` for a column. Names compare without letter case, `_` or `-` (first_name is firstName). The owner matches as serves and calls do.
- **config** (the same five): the key of a setting that names another system (a host, base URL, connection string, Key Vault, secret name), a timeout or retry, or a behaviour flag; without letter case, with `:` and `__` read as `.`. Values are recorded for a reader of the reference but not scored.

Facts are compared as one set per repo, so the same route in two apps of one repo counts once. Found means in both; missed means in the reference only; wrong means in the scan only, for kinds the reference covers.

Totals over every covered kind are reported, and beside them the total over serves, calls, stores and deploys only, which is what the baseline tables below measure.

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

## Fields and config (ADR 0124 §6, 2026-10-24)

Five references now also cover `fields` and `config`, one repo per stack, so every kind of fact the assistant writes is measured:

| Reference             | Stack                    |  Fields | of which columns | Config |
| --------------------- | ------------------------ | ------: | ---------------: | -----: |
| spring-petclinic-rest | Java, Spring Boot, JPA   |     184 |               30 |     12 |
| todo-csharp-sql       | .NET minimal API, EF     |      99 |               14 |      5 |
| todo-nodejs-mongo     | Node Express, Cosmos DB  |     113 |               14 |     10 |
| fastapi-template      | Python FastAPI, SQLModel |     122 |               12 |     13 |
| podinfo               | Go, HTTP and gRPC        |      68 |                0 |     11 |
| **All**               |                          | **586** |           **70** | **51** |

How they were written and checked:

- Read by hand at the pinned commits (fetched with `atticus bench fetch`): the OpenAPI document and H2 schema (petclinic), the request records and entity classes (.NET), the route handlers' body types (Node), the Pydantic and SQLModel models (FastAPI), and the JSON structs, map literals and protos (podinfo). The tables were typed once per schema and expanded per entry, so a schema shared by several entries is cited at the same property line each time.
- Every item's `at` was checked by a script against the clone: the cited line, or one either side, names the field or key (case and `_` aside). Three node-config keys are nested (`database.endpoint` cites the line with `"endpoint"`) and were checked by hand.
- The judgement calls are in each reference's `notes` and `ignore`: only success bodies (error bodies are not fields), PUT and DELETE responses of petclinic-rest ignored (the spec declares a body the controllers don't send), fields of calls not judged (the UIs' calls carry their APIs' bodies), Cosmos system properties and the OAuth2 form's unused fields ignored, and config limited to keys that name another system, a timeout or a flag (ports, own paths, logging and build settings ignored).
- The four kinds scored before are unchanged by the new kinds: the readers score the same 8/38/38, 12/12/2, 12/14/0, 0/43/23 and 36/12/1 on these repos as in the baseline above.

The built-in readers on the new kinds (no scan settings): fields 42 found, 544 missed, 0 wrong (28 of petclinic-rest's 30 columns, both missed ones on the `vet_specialties` join table, and all 14 EF columns of todo-csharp-sql; no request or response field anywhere); config 0 of 51 found, 0 wrong (podinfo's two manifest entries, the image and an env alias, are ignored).

## Scoring an assistant's facts (ADR 0124)

`atticus bench facts [<repo>] [--facts file]` projects the facts file the assistant wrote (`projectFacts`, the same projection `atticus verify` feeds the catalog) and scores the records with `bench run`'s matcher, so found, missed and wrong mean the same and the numbers compare with the readers' 58%/86% precision and 32%/58% recall. Without `--facts` it reads `<cache>/<repo>/.atticus/facts/<repo>.jsonl` (the assistant ran `/atticus map` in the clone) or `<cache>/facts/<repo>.jsonl`. It prints each repo's total, a line per kind, and the total over serves to deploys beside the total over every kind. Screens (no reference lists a UI's routes as served), their fields and flows (scored against `flows/`) are left out and counted; facts of another commit than the pin are refused. No clone is needed. The first measured run (A4: the assistant reading batch 1 with the verifier on) is recorded here when it is made.

## The assistant reading batch 1 (A4, 2026-10-24)

Claude (Opus) as the reading assistant, one session per one or two repos, following `/atticus-map` with `atticus verify` in the loop, never opening `bench/`. Every kept fact passed the verifier. Serves to deploys, the kinds the readers' baseline is measured on:

| Repo                     |   Found | Missed |  Wrong | Precision |  Recall | Readers (P / R) |
| ------------------------ | ------: | -----: | -----: | --------: | ------: | --------------: |
| spring-petclinic         |      25 |      0 |      0 |      100% |    100% |      100% / 96% |
| spring-petclinic-rest    |      46 |      0 |      0 |      100% |    100% |       17% / 17% |
| spring-petclinic-angular |      30 |      0 |      0 |      100% |    100% |         0% / 0% |
| eshop                    |     147 |      3 |     16 |       90% |     98% |       82% / 34% |
| eshop-modernizing        |      48 |      7 |     16 |       75% |     87% |       75% / 16% |
| microservices-demo       |      50 |      1 |     11 |       82% |     98% |       61% / 39% |
| **Batch 1**              | **346** | **11** | **43** |   **89%** | **97%** |   **60% / 31%** |

With fields and config (the two references that cover them): spring-petclinic-rest 96% precision, 98% recall over every kind.

eShop's reference gained its 14 YARP gateway routes and the gateway's calls on 2026-10-24 (the product owner's decision: a gateway's routes are its entries); the readers' 82% / 34% is against the reference before that.

**This batch is tuned, not held out.** It was read twice: the first read found the protocol's and the verifier's gaps (paths built across lines, gRPC names, routes without a leading slash, conventional routes, config keys with `:`), those were fixed (ADR 0124 addendum A4), and the facts were revised under the fixed protocol. The protocol's rules are product semantics, never the references' answers, but they were shaped on these repos, so batch 2 (16 repos, read once with the protocol frozen) is the measure that counts.

What the remaining wrong facts are, by count:

1. **Scope the references leave out and the protocol keeps** (most of the 43): Blazor form posts, the dev-only health checks, a hosted background service as a batch job, microservices-demo's load generator requests, and eshop-modernizing's hilo sequences and Azure SDK calls (both since ruled out by the protocol, after these reads). Each is a decision, recorded here, not hidden.
2. **Modelling differences:** a docker-compose host counted as a deploy in eshop-modernizing (the protocol says compose is local running), an Azure AI Foundry resource as a deploy in eShop, Redis key patterns as stores.
3. **Real misses:** two ASP.NET Identity tables used only by the library, the WebForms `.aspx` pages (since added to the protocol), and one call built from a runtime value.

## The assistant reading batch 2, held out (A4, 2026-10-24)

The 16 repos of batch 2, read once by four Claude (Opus) sessions with the protocol frozen after batch 1; nothing was tuned on them first. Serves to deploys:

| Repo                           |   Found | Missed |  Wrong | Readers' found / missed / wrong |
| ------------------------------ | ------: | -----: | -----: | ------------------------------: |
| spring-petclinic-microservices |      33 |     14 |      3 |                     30 / 17 / 4 |
| piggymetrics                   |      23 |      6 |      6 |                      4 / 25 / 9 |
| spring-realworld               |      44 |      0 |      0 |                    26 / 18 / 18 |
| spring-soap                    |       1 |      0 |      1 |                       0 / 1 / 0 |
| jenkins-maven                  |       0 |      0 |      0 |                       0 / 0 / 0 |
| eshop-on-web                   |      53 |     26 |     27 |                    18 / 61 / 29 |
| clean-architecture             |      13 |     17 |      3 |                      2 / 28 / 1 |
| todo-csharp-sql                |      24 |      0 |      0 |                     12 / 12 / 2 |
| angular-realworld              |      19 |      0 |      0 |                      0 / 19 / 0 |
| bulletproof-react              |      16 |     16 |      0 |                      0 / 32 / 0 |
| node-realworld                 |      27 |      0 |      0 |                     5 / 22 / 19 |
| nestjs-realworld               |      26 |      1 |      1 |                      21 / 6 / 0 |
| todo-nodejs-mongo              |      26 |      0 |      0 |                     12 / 14 / 0 |
| fastapi-template               |      42 |      1 |      3 |                     0 / 43 / 23 |
| fastapi-realworld              |      27 |      0 |      3 |                     0 / 27 / 19 |
| podinfo                        |      48 |      0 |     10 |                     36 / 12 / 1 |
| **Batch 2**                    | **422** | **81** | **57** |             **166 / 337 / 125** |

**88% precision, 84% recall**, against the readers' 57% and 33% on the same repos. Scored with three matcher equivalences added after the read and applied to every score (a GraphQL `Query.field` is the field; a platform compares without its cloud's prefix, `azure-app-service` is `app-service`; a websocket route compares as `rest`) and with scheduled jobs left out like screens (no reference lists them). Before those: 82% precision, 79% recall. Two reference copies for four of these repos were in a scratch folder the readers could reach; no reader reported opening them, and they are deleted.

Where it falls short of the bar (85% recall, 95% precision), biggest first:

1. **Routes a framework derives** (eshop-on-web, clean-architecture): slugified MVC routes, Razor Pages by file place, ASP.NET Identity's tables. The verifier couldn't check a path no line writes, so the readers wrote names as written or dropped them. Fixed after the read: the verifier now derives Razor Pages, WebForms and Next.js routes from the file's place and matches a slug against its name; the protocol says how to cite them.
2. **Calls through a gateway or a generated client** (spring-petclinic-microservices, piggymetrics, clean-architecture, bulletproof-react): the protocol's late rule that a page script's requests to its own app aren't calls was too broad, and a generated client not in the repo left no call site to cite. Fixed in the protocol: a front end's requests that reach another service are calls; a generated client's call is cited at its call site with the server's route in `with`.
3. **Framework endpoints** (fastapi-*, podinfo): API documentation and profiler routes. The protocol now leaves them out.

These fixes are measured only by a second read, which would make batch 2 tuned too; the number above is the held-out one.

### Batch 2, second read (tuned, 2026-10-24)

The same 16 repos revised once by four Claude sessions under the protocol and verifier as they stood after the held-out read and the flows round (still never opening `bench/`), and scored with the matcher as it stands (key-value stores' keys now left out like screens and scheduled jobs: references list tables and collections). piggymetrics' and spring-petclinic-microservices' references gained the gateway's forwarding calls (the product owner's decision that a gateway's routes count, as eShop's did). **96% precision, 93% recall.** This read is tuned: the rules it follows were shaped on the first read of these same repos. It says the protocol, read in full and followed, gets there; the held-out number above is what a first read of an unseen repo gave.

| Repo                           |   Found | Missed |  Wrong |
| ------------------------------ | ------: | -----: | -----: |
| piggymetrics                   |      32 |      1 |      3 |
| spring-realworld               |      44 |      0 |      0 |
| spring-soap                    |       1 |      0 |      0 |
| eshop-on-web                   |      75 |      4 |      1 |
| clean-architecture             |      23 |      7 |      6 |
| todo-csharp-sql                |      24 |      0 |      0 |
| angular-realworld              |      19 |      0 |      0 |
| bulletproof-react              |      16 |     16 |      0 |
| node-realworld                 |      27 |      0 |      0 |
| nestjs-realworld               |      26 |      1 |      0 |
| fastapi-template               |      42 |      1 |      2 |
| fastapi-realworld              |      26 |      1 |      0 |
| podinfo                        |      47 |      1 |      4 |
| todo-nodejs-mongo              |      25 |      1 |      0 |
| jenkins-maven                  |       0 |      0 |      0 |
| spring-petclinic-microservices |      47 |      1 |      2 |
| **Batch 2, second read**       | **474** | **34** | **18** |

What is still wrong: clean-architecture's ASP.NET Identity tables (no line in the repo names them; the database is made by `EnsureCreated`) and bulletproof-react's calls (their base path lives only in `.env.example`, which the protocol never cites).

## The stories bench (Phase B)

`stories/rubric.md` is the rubric for a professional user story, and three reference stories, written by reading the code with every changed step, criterion and error case cited, are the answers:

| Story                          | Repos                                      | Steps | Criteria | Error cases | Fields |
| ------------------------------ | ------------------------------------------ | ----: | -------: | ----------: | -----: |
| petclinic-pet-microchip        | spring-petclinic-angular, -rest            |     8 |       10 |           5 |      4 |
| microservices-demo-cart-limit  | microservices-demo (cartservice, frontend) |     2 |        6 |           4 |      3 |
| fastapi-template-item-due-date | fastapi-template (back and front end)      |     8 |       10 |           5 |      5 |

`atticus bench stories --draft <file>` scores a draft (the same format, `BenchStory` in `packages/evals/src/story-bench.ts`) on changed-step coverage, field coverage, error-case coverage, invented fields (fields known to neither the reference, the bench references of its repos nor the repos' facts; must be none, exit 1) and the rubric's 17 sections. Each reference story scores full marks against itself; golden tests score an invented good draft (7 of 8 steps, 4 of 4 fields, 4 of 5 error cases, nothing invented, 17 of 17 sections) and an invented bad one (1 of 8, 2 of 4, 0 of 5, three invented fields, 5 of 17).
