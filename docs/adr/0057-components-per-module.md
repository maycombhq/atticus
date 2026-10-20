# 0057. One component per deployable module

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

A repo maps to one component (ADR 0016: the manifest's `component`, else the repo id). Many repos build more than one deployable: a Maven or Gradle multi-module repo with an API, a batch job and a shared library, each deployed on its own, with its own `spring.application.name` and its own hosts. Today every endpoint, call and loose end in such a repo belongs to one component, so the catalog can't say which deployable serves an endpoint or makes a call, a call between two of the repo's own modules looks like a call to itself, and hosts can only be declared for the repo as a whole.

## Decision

**Contract C6, an addition** (optional, ADR 0041's rule): a repo in `repos.manifest.yaml` may list `modules`, each a folder (`path`), the `component` it builds and optionally its `hosts` (ADR 0053):

```yaml
- id: tide-accounts
  modules:
    - { path: accounts-api, component: accounts-api, hosts: [accounts.tide.internal] }
    - { path: accounts-jobs, component: accounts-jobs }
```

**When the manifest lists none, they are found:** a repo with two or more deployable modules (a folder with its own build file, `pom.xml`, `build.gradle` or `build.gradle.kts`, whose code has a `@SpringBootApplication` class) gets one per deployable module. Its component is the module's `spring.application.name` (from its own config, read the way ADR 0054's layered config is), else the folder's name. A repo with one deployable stays one component, as before.

**Contract C4, an addition**: `ScanContext.modules` (folder → component), so an extractor can say which component a file belongs to. The built-in extractors use it for what code serves and calls (Spring, the house-framework extractor, the .NET, Node, Python and Go backends, OpenAPI files, and every loose end): a fact belongs to the module its file is in, else to the repo's component. The component extractor emits a Component for each module, as well as the repo's own (which keeps what is outside every module: shared libraries, root config). A module's `hosts` join calls to that module's component.

Settings, data and infrastructure facts stay with the repo's component for now.

## Consequences

- Each deployable in a multi-module repo is its own component, with its own endpoints, calls and hosts, and calls between them are interfaces.
- Component ids in repos with two or more Spring Boot apps change (more components, each named after its app). A rescan shows them as new; curated decisions on the old ids still apply to the repo's component.
- Non-Spring multi-module repos need `modules` in the manifest until their deployables can be recognised.
