# 0143. Where a component is reached, read from its Routes

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0053 (hosts a repo answers on), 0124 (facts the assistant writes; addenda A4, A-gateway, A-framework, C-join, J0, P-measure), 0134 (a shared host and each repo's base path)

## Context

The estate join ties a call to the repo that serves it by the host the call uses and, on a shared host, by the base path in front of the repo's routes (ADR 0134). Both came only from `repos.manifest.yaml`, written by hand: a person had to copy each service's ingress host and `/forge-svc/<module>` prefix out of the deploy repo into the manifest, and keep them in step.

Those values are already written down, in code the reader reads: an OpenShift Route's `spec.host` and `spec.path`, an Ingress rule's host and path, the Helm values a templated Route takes its host from, and an Apigee proxy's `<BasePath>`. A deploy repo holds most of them, for components whose code is in other repos. What the code says, cited, should carry the link, and the manifest should only have to say what no repo writes: a gateway's environment hosts, which are set in the gateway's own console or environment configuration and rarely in a proxy repo.

## Decision

### 1. Exposure fields on the deploy fact

A `deploy` fact gains three optional fields (the facts file, `packages/core/src/schema/facts.ts`):

- `host`: the host the component is reached on, as served, never a template.
- `basePath`: the path its routes sit under on that host, from a leading `/`.
- `exposes`: the component the host and base path reach, when the fact is read in another repo (a deploy or config repo); left out, it is the fact's own component.

`env`, already on the fact, says which environment a host is for. A deploy fact with a `host` or a `basePath` is an **exposure**.

Fields on the existing kind, not a kind of its own: a Route is a deployment resource and is already read as one (`resourceType: route`, `resourceName` its name), the projection into C1's `Deployment` is unchanged, and a kind would widen `FACT_KINDS` and everything that names a kind (A-framework's cost) for a claim that has no identity apart from the resource that makes it.

The host's and the path's lines ride on `cite.with`, as A-framework's version does: `cite` is the resource's name line (`metadata.name`, `<APIProxy name>`), and the host and the path are each written on it or on one of its parts. No `hostCite` field: each would cost every batch's facts reference tokens for a shape `cite.with` already has.

`exposes` is a field of its own, not `component`. A deploy repo's fact with `component: accounts-api` would be read as a module of the deploy repo: projected as its Component, and renamed estate-unique (`componentRenames`) when the service's repo has one of that id, which would break both the catalog and the join.

### 2. A templated host cites its values file

A Route written `host: {{ .Values.route.host }}` is the Helm analogue of J0's `${X}`. J0 resolves a placeholder at join time, through config facts, because the call's code and the setting are in different repos read in different sessions. A Helm template and its values file are in one repo and one chart, read together, so the reader can do what J0 does in one step and cite it: `host` is the host the values file sets, and the values file's line is a `cite.with` part (with the template line too, as a part, if it likes). One fact per environment's values file, each with its `env`. The verifier then checks the host on that line like any claim, with no Helm evaluation and no cross-repo resolution. A `host` still written as a template (`{{`, `}}` or `${`) is rejected (`exposure-template`), the message saying to cite the values file.

### 3. Verify checks the claim on its line, and the component

- `host` must be written on the cited line or a `cite.with` line (a word claim, as a framework's version is); `basePath` the same (a route or word claim). An invented host or path is `claim-not-on-line`.
- `exposes` must be a component or repo of the estate: `VerifyOptions.estate` (optional) gives the components, and `atticus verify` and `atticus map`'s batches pass every repo id, component and module component of the org pack's manifests (`estateComponentsOf`). One that names none is rejected (`exposure-component`); the message says to name the component the route reaches or, when no file says which, to write a question. With no manifest, nothing checks the name.
- An exposure with no `exposes` in a repo whose facts serve no entry (a deploy repo's) is rejected with the same code: its Routes reach another repo's component, so it must name it.

### 4. The join takes hosts and base paths from both

`joinFacts` builds, per repo and module, the hosts and base paths it is reached on from the manifest (as before) and from every exposure that resolves to it (`exposes` by repo id, by a repo's component, by a module's component, by a component the facts name, or made estate-unique). Every host is paired with every base path, as a module's base path already pairs with its repo's hosts (ADR 0134); a base path read with no host (a proxy's `BasePath`) takes the hosts the manifest lists, and the base-path rules of ADR 0134 then apply unchanged. A join an exposure made possible cites it: `FactJoin.exposedBy` (and `GatewayHop.exposedBy` for a hop), added by `joinRecords` to the Interface's evidence as `infrastructure`. What the manifest lists itself is not cited again.

**A conflict is a finding, never a silent override.** `FactsJoinResult.exposure` lists:

- `host-conflict`: the manifest lists hosts for the component and the exposure's is none of them;
- `base-path-conflict`: the manifest gives a base path and the exposure another;
- `no-component`: `exposes` names nothing of the estate, so nothing is joined by it.

In a conflict **both** values are joined: the manifest is a person's configuration and the Route is code, and neither may quietly win (a document never overrides a fact verified from code, and a fact doesn't rewrite a person's word). `atticus verify <repo> --write` prints each finding (`Exposure: …`) and writes them under `exposure` in `<repo>.verify.yaml`, for the deploy repo and for the component's repo; a person settles it by fixing the manifest or the code.

`joinAbout` writes a join again with the repo whose exposure it cites, as J0 does for a setting, so a changed Route moves the link at its repo's `verify --write`.

### 5. The reading rule

The deploy rule gains one part (`deploy` and `gateway` batches): where a component is reached goes on a deploy fact, the host and path lines in `cite.with`, a templated host via its values file, one fact per environment, and `exposes` for a deploy repo's Route, asking when no file says which. `FACT_RULES` was re-pinned, the `/atticus-map` golden updated and `plugins/atticus` and `plugins/copilot` regenerated. The facts reference, generated from the schema, gains `host?`, `basePath?` and `exposes?` on the deploy line (about 45 characters in every batch).

### 6. The facts contract

`FACTS_SCHEMA_VERSION` (new, in `facts.ts`) is 2. Version 1 is everything before: the facts file has never carried a number on its lines, and doesn't now, so a file written before reads as version 1 and parses unchanged, every new field being optional. No `atticus upgrade` step: nothing on disk must change. Old facts files, old manifests and old verify reports read as they did; `exposure` in a verify report is optional and written only when there is a finding.

### 7. Measured

On `fixtures/link-estate` (P1) the deploy repo now holds OpenShift Routes for the four services (one a Helm template whose host is in `charts/payments/values.yaml`), and each proxy repo a deploy fact for its `<BasePath>`. `repos.manifest.yaml` no longer lists the services' hosts and base paths or the proxies' base paths; it keeps only the gateway host `api.forge.example`. The figures are the same as when the manifest said it all (precision 0.909, recall 0.769, 10 of 13 right, one asked, one unlinked, one not read), pinned in `packages/scanner/test/measure-links.test.ts` and `packages/cli/test/measure-cli.test.ts`; with the exposure fields stripped from the facts, the same trimmed manifest gives 0.5 and 0.231 (six calls asked), also pinned.

## Consequences

- An organisation can stop copying ingress hosts and base paths into the manifest: reading the deploy repo is enough, and the manifest says only what no repo writes.
- A manifest that disagrees with the deploy repo is now visible after a write, instead of being the only word.
- The scan's own merge of the readers' records (`mergeEstate`) still reads only the manifest's hosts: the built-in readers are a cross-check (ADR 0124), and the facts' join is where the link is made.
- Not yet: an Ingress whose path is a regular expression (`/forge-svc/accounts(/|$)(.*)`) is the reader's to write as its plain prefix; a Service's in-cluster address (`<svc>.<ns>.svc.cluster.local`) is not an exposure, since no line writes it whole; `exposes` resolves against the manifest's components only at verify, so a module the manifest doesn't list is named by its repo instead.
