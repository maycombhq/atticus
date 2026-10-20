# 0061. Dialect fields: nested objects, collected lists, the component

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

A pipeline is one record whose facts are lists gathered from many places in one file: a Harness pipeline's stages, the environments its deploy stages target, the steps that run tests. The built-in pipeline readers write them as a QualityAsset `pipeline` whose `details` is an object (`stages`, `triggers`, `environments`, `deployTargets`, `testSteps`, `templates`). A dialect couldn't: a field was a template, a number, a boolean or a list of templates, each rendered once per match. So a CI/CD tool Atticus doesn't know (Harness, Tekton, Argo CD, a house pipeline DSL) couldn't be described as rules, drafted or hand-written. Rules also couldn't name the component a file belongs to (the manifest's, a module's, ADR 0057) the way built-in readers do.

## Decision

**Contract C2, additions** (optional, ADR 0041's rule):

- **A field's value may be an object** of field values, nested up to three levels deep: `details: { tool: harness, stages: [...] }`. A key whose value can't be filled is left out of its object, as a top-level field is (ADR 0056).
- **A list item may collect**: `{ each: "@.pipeline.stages[*].stage", value: "${item.name}" }` gives one value per node the relative path finds under the matched node (`@` is the match; `.key`, `[*]`, `*`, `[N]` and `..key` as in `jsonPath`), rendered with `${item}` (the node, when it is a plain value) or `${item.<dotted field>}`. Values that can't be filled are dropped, duplicates kept once, in document order. `each` needs a `jsonPath` match.
- **`${repo.component}`**: the component the matched file belongs to: its module's (ADR 0057), else the repo's manifest component, else the repo id.

## Consequences

- A dialect can describe a pipeline as the built-in readers do, so pipelines from any CI/CD tool read the same way: Atticus ships Harness, Tekton and Argo CD dialects (ADR 0062), and onboarding can draft others.
- The same shapes serve any record with list or object fields (an Endpoint's `schemaRefs`, a Deployment's details).
