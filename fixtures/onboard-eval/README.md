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
