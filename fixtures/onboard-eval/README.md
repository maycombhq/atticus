# Onboarding evaluation (invented)

Cases for `atticus onboard eval` (ADR 0059): each is a repo Atticus can't read with its built-in
readers, and a reference dialect a person wrote for it. The evaluation has the organisation's
assistant draft a dialect for each repo, then compares what the draft reads from the repo with
what the reference reads, record by record, by content (not by id). Run it where the model is:
`atticus onboard eval fixtures/onboard-eval --mode model`. CI runs it with a replay of the
references, which checks the harness, not a model.

| Case            | Ecosystem                                                        |
| --------------- | ---------------------------------------------------------------- |
| `apigee`        | Apigee proxies with target servers per environment               |
| `kong`          | Kong declarative config                                          |
| `apim`          | Azure API Management (APIOps folders)                            |
| `aws-apigw`     | AWS API Gateway: OpenAPI with `x-amazon-apigateway-integration`  |
| `house-gateway` | A house gateway's own route files                                |
| `house-http`    | A house HTTP client in Java, Kotlin and TypeScript               |
| `tf-topics`     | Kafka topics from a house Terraform module                       |
| `harness`       | Harness pipelines with parallel stages and an org template       |
| `tekton`        | Tekton Pipelines                                                 |
| `argocd`        | Argo CD Applications per environment folder                      |
| `harbor-kit`    | A framework case (ADR 0066): a house Java starter with a wrapper the learner can't read, base URLs in a properties file and a Jenkins shared-library step, two repos using it, a recorded assistant answer (`assistant-reply.yaml`) and the reference model |

A framework case's `case.yaml` has `kind: framework`, `from` (the framework's source), `users` (the repos that use it) and `reference` (the model a person accepted). The learner reads `from` first; the draft is graded by what it adds to the `users` repos (records they give with the model and not without), compared with what the reference adds.
