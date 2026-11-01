# A vendor's API changes

Your organisation probably calls some vendors through its own external API gateway: an Apigee proxy whose routes forward to the vendor's host. When the vendor publishes a new version of its API, three things may need to change: the proxy's routes, the services that call through them, and the callers of those services.

Atticus compares the vendor's two specs and follows each change through the gateway to the code that depends on it. Every step cites a file and a line. Nothing here calls a model (ADR 0130).

## 1. Feed each version beside the last

Add the vendor's spec to the metarepo's `inputs/` folder, and keep each version as its own file:

```sh
atticus intake add northwind-pay-openapi-v1.yaml   # the version you call today
atticus intake add northwind-pay-openapi-v2.yaml   # the version the vendor just published
atticus intake list
```

**Never write a new version over the old file.** Intake keeps both versions, reads the newer one into the catalog and marks the older one as superseded. `atticus intake list` shows the chain under **Versions**, for example `doc.northwind-pay-openapi-v1 → doc.northwind-pay-openapi-v2`. If the new version replaces the old file, there is nothing left to compare.

Two files count as versions of one spec when either:

- they have the same title (`info.title`), or
- they have the same file name once the version or date is taken out.

The version (`info.version`, or a `v2` or a date in the file name) says which one is newer. When nothing says, `atticus triage` asks you.

The spec must be linked to the vendor's system in the org pack. Intake links it through the vendor's name or an alias, by the spec's title or its file name. If neither matches, `atticus triage` asks you which system it is.

OpenAPI 3 and Swagger 2 specs are compared. For each operation, Atticus reads:

- its method and path;
- its auth and scopes;
- its request and response fields, each with its type, whether it is required, and its enum values;
- the headers its success response lists (OpenAPI 3's `responses.<2xx>.headers`, and Swagger 2's), as response fields that are headers;
- its error responses (each 4xx and 5xx status) and the fields of each one's body.

Every operation and field cites the line of the spec it comes from. The newer version's operations go into the catalog as the vendor's Endpoints, each with a request Schema and a response Schema.

## 2. See what changed, and what it reaches

```sh
atticus intake impact inputs/partner-specs/northwind-pay-openapi-v2.yaml
```

You can name either version. Atticus compares it with the version it replaces, or with the one that replaces it.

For each change, the command prints one plain sentence:

```
Breaking: POST /charges/{chargeId}/refunds: the request field reason is now required; a caller that leaves it out is refused.
  was inputs/partner-specs/northwind-pay-openapi-v1.yaml:119, now inputs/partner-specs/northwind-pay-openapi-v2.yaml:129
  forwarded by partner-gateway: POST /v1/charges/{chargeId}/refunds, forge-partner-gateway proxies/northwind-pay-v1/apiproxy/proxies/default.xml:11 (to Northwind Pay through environments/prod/targetservers.json:4)
    called by billing-api: forge-billing src/main/java/forge/billing/NorthwindClient.java:23, doesn't send reason
      under forge-billing src/main/java/forge/billing/InvoicesController.java:23
```

Under the sentence, the command shows:

- **The lines it cites in each version** (`was …, now …`).
- **The forwarding calls** in your external gateway that reach that operation today, and the TargetServer that ties each one to the vendor's host.
- **The service calls** that go through each route. When the change is to a field and the call's facts list its fields, Atticus says whether the call sends the field. Above, billing doesn't send `reason`, so its refunds will be refused.
- **The callers further up the chain**: the entry each service call is made under, and who calls that entry, and on up.

Atticus marks each change as breaking or additive by fixed rules, from a caller's side:

- **An operation:**
  - removed or moved: breaking;
  - added: additive.
- **A request field:**
  - removed or renamed: breaking;
  - added as required: breaking;
  - added as optional: additive;
  - made required: breaking.
- **A response field:**
  - removed or renamed: breaking;
  - made optional: breaking.
- **A field's type**, changed: breaking.
- **Enum values:**
  - a value a request field no longer takes: breaking;
  - a new value a response field may return: breaking.
- **Auth and scopes:**
  - the auth changed: breaking;
  - a new scope the token needs: breaking.
- **A response header** is compared as a response field is, and said as a header.
- **Error responses** (4xx and 5xx):
  - one the operation may now answer: breaking (a caller must handle it);
  - one it no longer answers: additive;
  - one whose body changed: each field compared by the response rules above, said with its status ("its 402 response").

The full table is in ADR 0130.

A rename is a guess. One field went and one came, in the same place and of the same type. Atticus says "is now", and you check it.

Below the changes, the command lists the affected repos and flows. It also lists two kinds of problem in your gateway:

- **A forwarding call to an operation the vendor doesn't publish.** This is a gap.
- **A forwarding call that two operations fit equally well.** This is a question.

`--json` gives the comparison and the impact as data (`{ diff, impact }`).

The command exits with:

- 1 when a breaking change reaches something in your estate;
- 0 when no breaking change does.

So a pipeline can stop on it.

The impact reads your repos' verified facts (`facts/<repo>.jsonl`). A repo that hasn't been mapped and verified isn't in it, and the command says so.

## 3. Start a change from it

```sh
atticus change new "Absorb Northwind Pay 2.0.0" --type integration --impact inputs/partner-specs/northwind-pay-openapi-v2.yaml
```

The change starts with its footprint filled in:

- the vendor's system and the affected repos' systems;
- the repos;
- the Interfaces, as planned to change;
- the flows;
- the vendor's Endpoints.

The impact is attached to the change as `inputs/northwind-pay-2-0-0-impact.md`. Every stage reads it as data.

`atticus change status` shows the footprint and the risk it adds up to, as for any change. The stages can still widen or narrow the footprint.

## Another team's spec

The same works for an API another team of your organisation owns and publishes, when no repo of yours belongs to it. Declare their system in the profile, with `boundary: internal` (a hosts question can add it, with the host as its alias), and add their OpenAPI spec to `inputs/` as above. Intake links it by the system's name or an alias, and `atticus intake impact` compares its versions.

Your services usually call another team's API themselves, not through the external gateway. So for their system, Atticus also lands each service's own call on the team's operation, by the call's target, its host (the spec's servers, or a host alias), and its method and path:

```
Breaking: POST /v1/assessments: the request field channel is now required; a caller that leaves it out is refused.
  called directly by billing-api: POST /v1/assessments, forge-billing src/main/java/forge/billing/RiskClient.java:12 (on Forge Risk Team), doesn't send channel
    under forge-billing src/main/java/forge/billing/InvoicesController.java:13
    ← shop-bff: forge-shop-bff src/main/java/forge/shop/BillingClient.java:9, under forge-shop-bff src/main/java/forge/shop/CheckoutController.java:16
```

A vendor's direct calls are still left to the gateway's routes, as before (ADR 0142).

## Your own change's impact

The same view works for a change of your own, once its architecture stage has written its target flows:

```sh
atticus change impact hold-stock
```

For each entry or table the target flows break (a field a response stops returning, an entry that reads another field, a field now required, a column whose type changes, a flow removed), it lists who calls or uses it today, the fields that stop crossing, and the gateway routes the callers go through, which need updating. Each part names the team that owns it: the repo manifest's `owner`, with the name `roles.yaml` gives the team. The same view is on the change's Architecture tab in the app, under **What this change breaks**.

A link the map only guessed (joined by path, by a host's first label, by a platform-wide setting or a setting's folder name, or despite an open host conflict) is shown as **may break (link guessed)** and is never counted as a break. The critic's `constitution.change-links-known` asks the caller's owner to confirm it ([ADR 0140](../adr/0140-a-change-warns-on-guessed-links-and-questions-go-to-their-owner.md)); see [ADR 0144](../adr/0144-a-changes-impact-and-proposed-answers.md).

It then walks up the chain: who calls each affected caller's entries (the entries of the caller's flows that make the call, or every entry it has when the map doesn't say which), through catalog Interfaces and the gateway routes they go through, hop by hop with each hop's owner, until no new caller turns up or five hops up. Each hop says which caller it calls through (indented in the command's words, a **Calls** column in the app). A hop that rests on a guessed link, its own or one further down, may break and is never counted as a break; a component already on the chain isn't walked again, so a cycle stops. See [ADR 0156](../adr/0156-a-changes-impact-up-the-chain-seeds-and-vendor-headers-and-errors.md).
