# Worked example: the Forge dialect

Forge is an invented in-house Java framework. This is the complete dialect that teaches Atticus to read it, the source it reads, and why each rule is written the way it is. Every value in it was checked by running its tests.

## The framework, as found in a repo

A Forge service has a descriptor at its root, `forge.yaml`, naming the service:

```text
# forge.yaml
service: ledger-api
system: ledger
framework: forge
```

It serves REST endpoints with `@ForgeEndpoint` on methods:

```java
@ForgeService(name = "ledger-api")
public class LedgerEndpoints {

  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")
  public Balance balance(String id) { return null; }

  @ForgeEndpoint(method = "POST", path = "/transfers", auth = "oauth2")
  public TransferResult transfer(TransferRequest request) { return null; }
}
```

It calls other services through client interfaces: `@ForgeClient` names the target service, and each `@ForgeCall` method is one request:

```java
@ForgeClient(service = "northwind-pay", baseUrl = "${northwind.url}")
public interface NorthwindClient {
  @ForgeCall(method = "POST", path = "/v2/payments")
  PaymentResult pay(PaymentRequest request);
}
```

And it publishes and consumes topics:

```java
public class LedgerEvents {
  @ForgeSubscribe(topic = "payments.initiated")
  public void onPaymentInitiated(Object payment) { }

  @ForgePublish(topic = "transfers.completed")
  public Object transferCompleted(Object transfer) { return transfer; }
}
```

`atticus dialect new forge --from repos/forge-ledger` finds `forge.yaml` as the marker, its `service` key as the app's name, and these six annotations; `@ForgeService` and `@ForgeClient` are reported as enclosing the others, so they get no candidate rule of their own.

## The dialect

```yaml
schemaVersion: 1
name: forge
version: 0.1.0
description: Forge services declare endpoints, clients and events with annotations, and name themselves in forge.yaml.
extends: []
appliesTo:
  repoTypes: [forge-service]
  marker: forge.yaml
layout:
  sourceRoots: [src/main/java]
  configFiles: [src/main/resources/application.yml]
rules:
  - id: forge-endpoint
    description: A method annotated @ForgeEndpoint serves a REST endpoint of the service named in forge.yaml.
    match:
      annotation: ForgeEndpoint
      target: method
      files: ["src/main/java/**/*.java"]
    emit:
      kind: Endpoint
      id: "${yaml:forge.yaml#service}.${attr.method | lower}-${member.name | slug}"
      fields:
        component: "${yaml:forge.yaml#service}"
        endpointType: rest
        method: "${attr.method | upper}"
        pathOrTopic: "${attr.path}"
        normalizedPath: "${attr.path | normalizePath}"
        auth: "${attr.auth | default('none')}"
      evidence: { source: code, side: callee }
    confidence: verified

  - id: forge-client-call
    description: A method annotated @ForgeCall in a @ForgeClient interface calls another service directly (not through the gateway).
    match:
      annotation: ForgeCall
      target: method
      files: ["src/main/java/**/*.java"]
    emit:
      kind: Interface
      fields:
        from: "${yaml:forge.yaml#service}"
        to: "${annotation.ForgeClient.service}"
        via: direct
        method: "${attr.method | upper}"
        normalizedPath: "${attr.path | normalizePath}"
        sync: sync
      evidence: { source: code, side: caller }
    confidence: inferred

  - id: forge-publish
    description: A method annotated @ForgePublish publishes to a topic; the consumer is resolved later from topic configs.
    match:
      annotation: ForgePublish
      target: method
      files: ["src/main/java/**/*.java"]
    emit:
      kind: Unresolved
      id: "${yaml:forge.yaml#service}.publish.${attr.topic | slug}"
      fields:
        unresolvedKind: event-publish
        raw: "${attr.topic}"
        owner: "${yaml:forge.yaml#service}"
      evidence: { source: code, side: caller }
    confidence: inferred

  - id: forge-subscribe
    description: A method annotated @ForgeSubscribe consumes a topic; the producer is resolved later from topic configs.
    match:
      annotation: ForgeSubscribe
      target: method
      files: ["src/main/java/**/*.java"]
    emit:
      kind: Unresolved
      id: "${yaml:forge.yaml#service}.subscribe.${attr.topic | slug}"
      fields:
        unresolvedKind: event-subscribe
        raw: "${attr.topic}"
        owner: "${yaml:forge.yaml#service}"
      evidence: { source: code, side: callee }
    confidence: inferred

tests:
  - name: endpoints and the direct vendor call in forge-ledger
    fixture: ../../../repos/forge-ledger
    expect:
      - kind: Endpoint
        id: ledger-api.get-balance
        method: GET
        pathOrTopic: /accounts/{id}/balance
        normalizedPath: /accounts/{}/balance
        auth: oauth2
      - kind: Endpoint
        id: ledger-api.post-transfer
        method: POST
        pathOrTopic: /transfers
      - kind: Interface
        id: if-e7344c9455608119
        from: ledger-api
        to: northwind-pay
        via: direct
        method: POST
        normalizedPath: /v2/payments
    absent: [ledger-api.get-accounts]
  - name: a service with no forge.yaml produces nothing
    files:
      src/main/java/x/A.java: |
        @ForgeEndpoint(method = "GET", path = "/a")
        public void a() {}
    expect: []
```

## Rule by rule

- **`appliesTo`.** `marker: forge.yaml` means the dialect does nothing in a repo without that file at its root, so a Spring repo that happens to have a class named like a Forge annotation is left alone. `repoTypes: [forge-service]` makes it apply in a scan to every repo the manifest types as `forge-service`.
- **`layout`.** `configFiles` is where `${config:...}` would read; this dialect doesn't use config, so it is only documentation here, as is `sourceRoots`.

### `forge-endpoint`: an endpoint the service serves

- **Match.** `@ForgeEndpoint` on methods, in production code only (`src/main/java/**/*.java`, so tests under `src/test` are never read).
- **Kind.** The service serves it, so `Endpoint`, `endpointType: rest`.
- **Id.** `${yaml:forge.yaml#service}` takes the service name from the descriptor (the annotation on the class could give it too, but every Forge repo has the descriptor). `${attr.method | lower}` and `${member.name | slug}` make `ledger-api.get-balance` from `method = "GET"` on method `balance`. `lower` and `slug` matter: ids must be lowercase.
- **Fields.** `method` is upper-cased so `get` and `GET` agree. `pathOrTopic` keeps the path as written; `normalizedPath` turns `{id}` into `{}` so the same endpoint found by other extractors (the OpenAPI file, the gateway) gets the same identity. `auth` falls back to `none` with `default('none')`, because a missing value would otherwise leave the field unset.
- **Confidence `verified`**: the service's own code proves it serves the endpoint. `side: callee`.

### `forge-client-call`: a call to a named service

- **Match.** `@ForgeCall` methods. The target service is not on the method but on the interface around it, so `to` is `${annotation.ForgeClient.service}`: an attribute of an annotation on the enclosing type.
- **Kind.** The code names the other side (`northwind-pay`), so this is an `Interface`, not a loose end. There is no `id`: the engine derives `if-e7344c9455608119` from `ledger-api|northwind-pay|POST|/v2/payments`. The test's id was copied from `atticus dialect run`.
- **Fields.** `via: direct` (the client calls the service itself, not through a gateway) and `sync: sync` are literals, true of every Forge client. `from`, `to` and `normalizedPath` must all be filled or the call is skipped.
- **Confidence `inferred`**: only the caller's side is seen in this repo. `side: caller`.

### `forge-publish` and `forge-subscribe`: loose ends

- A topic doesn't name who consumes or produces it, so these are `Unresolved` records following the loose-end grammar: `unresolvedKind: event-publish` or `event-subscribe`, `raw` the topic exactly as written, `owner` the service. A later merge step pairs publishers with subscribers through the topic configs.
- Ids `ledger-api.publish.transfers.completed` and `ledger-api.subscribe.payments.initiated`: component, verb, topic through `slug`.
- `side`: a publisher is the `caller`, a subscriber the `callee`.

## The tests

- The **fixture test** scans the real repo (the path is relative to the dialect file; in this estate the org pack sits at `metarepo/org-pack/dialects/`, hence three levels up) and checks each kind the dialect emits, with the fields that matter. `absent` guards against an id that must never appear.
- The **inline test** has no `forge.yaml`, and `expect: []` with inline `files` means "produces nothing at all": proof that the marker works.
- What these tests don't cover, and a new dialect's tests should: the loose ends (add `Unresolved` records to `expect`), and an inline test per edge case found while surveying.
