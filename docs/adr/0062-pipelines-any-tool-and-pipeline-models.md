# 0062. Pipelines from any CI/CD tool, and what an organisation's pipeline templates do

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

The built-in pipeline readers cover Azure Pipelines, GitHub Actions, GitLab CI and Jenkins. Banks also run Harness, Tekton, Argo CD and others, and they customise all of them the same way: the steps that matter live in a platform team's shared place, in another repo — Harness templates (`templateRef`), Azure templates in a templates repository (`template: deploy.yml@templates`), GitHub reusable workflows and house actions, GitLab includes, Jenkins shared libraries (`deployToProd(app: 'cards', env: 'prod')`). A pipeline that only names `deployToProd` says nothing about where it deploys unless something knows what `deployToProd` does. Rules read one repo, so a dialect can't know.

## Decision

**Shipped dialects for Harness, Tekton and Argo CD**, using ADR 0061's nested and collected fields: a Harness pipeline or a Tekton Pipeline is a QualityAsset `pipeline` with the same `details` the built-in readers write (stages, environments, deploy targets in Atticus's words, test steps, templates); an Argo CD Application is a GitOps Deployment. They are ordinary dialects: an organisation's own dialect extends or replaces them, and onboarding drafts others the same way.

**Contract C2, additions** (optional, ADR 0041's rule):

- `appliesTo.repoTypes` may hold `"*"`: the dialect applies to any repo, gated by its `marker`. Shipped dialects for widely used tools use it.
- A `map('K8sRollingDeploy=kubernetes,HelmDeploy=helm')` filter: a tool's word to Atticus's; a value with no entry is unknown (so `| default(...)` can follow).
- A collecting list item may have `where` conditions on `${item...}`: only nodes where all hold give a value.
- `jsonPath` matches read every YAML document in a file (`---`).
- Any match may have `contains` (a text, or a list of which one is enough): a file without it isn't parsed. A dialect over `**/*.yaml` in every repo would otherwise parse every YAML file of the estate; `contains: tekton.dev` keeps that to the files that can match.

**Contract C6, an addition: pipeline entries in framework models** (`org-pack/frameworks/<name>.yaml`, ADR 0054). An entry names a template (`uses: org.tide_release`, `deploy.yml@templates`, `tide/actions/deploy-helm`) or a Jenkins shared-library step (`step: deployToProd`, with `environmentFrom: env` for the named argument that says the environment), and what it adds: `stages`, `environments`, `deployTargets`, `testSteps`, with its `source` (code, a document, a person). After every scan, each pipeline record whose `details.templates` holds a template an entry names (as written, or without its `@version`) gains what the entry says, and `details.modelled` names the entry, its model and its source. The Jenkins reader applies `step` entries as it reads, since the environment is in the call. A GitHub action a model names becomes one of the pipeline's templates.

## Consequences

- A pipeline from any of these tools, and the org templates and library steps behind it, reads the same way, and every added fact says which model gave it and where that came from.
- Pipeline entries are written by the platform team, or drafted from the template repository by its assistant (`atticus frameworks kit`); the automatic onboarding loop for framework models is a follow-up.
- Not yet: Harness triggers (their own files) and Tekton PipelineRuns and Triggers joined to their pipelines; Argo CD ApplicationSets; Spinnaker, TeamCity, Bamboo, Octopus and CircleCI (onboarding drafts them).
