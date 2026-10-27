# 0133. A prototype compared with the estate

- Status: accepted (pending review by the product owner)
- Date: 2026-10-26
- Builds on: ADR 0113 (files attached to a change), 0124 (facts the assistant writes; addenda A-gateway, A-gateway2, A-framework, A-about, B-change, C-join), 0125 (a Schema field says whether it is required), 0128 (what a repo is, in a person's words), 0130 (a vendor's operations)

## Context

There is no Figma reader. A team often has something better: a working **prototype**. It is a UI and its BFF, with SSO wired in and the backend **mocked**.

- Its screens, fields and calls state exactly what the change must deliver.
- Its mocks state exactly what the backend must provide.

The product owner wants to give Atticus such a prototype and have it work out the rest: which of those calls the estate already serves, which need changing, which are new, and which only a vendor provides.

Atticus already had most of the pieces: the reading protocol and the verifier, the estate join and its walk through gateways, ADR 0130's vendor matching, B-change's footprint, and files attached to a change. What it lacked was a way to say "this repo is a prototype", a reading rule for mocks, and the comparison itself.

## Decision

### 1. A prototype is a repo type, not a new field

The manifest's `type` is a free id from the platform profile. A repo typed `prototype` (or `prototype-<anything>`) is a prototype (`isPrototypeType`, core `facts-join-prototype.ts`). No C1 to C6 field is added.

```yaml
- id: forge-checkout-prototype
  url: https://git.example.com/forge/forge-checkout-prototype.git
  description:
    text: "A clickable prototype of checkout with loyalty points: a React UI, its Express BFF behind the shop's SSO, and MSW and WireMock mocks of the backend."
  type: prototype
  owner: team-shop
```

What the prototype is comes from ADR 0128's description, and is shown wherever the prototype is.

### 2. Read, verified, and kept out of the production catalog

A prototype is read like any repo (`/atticus-map`, `atticus verify`). Its facts are verified on their lines and kept in `facts/<repo>.jsonl`. Then:

- `atticus verify <repo> --write` writes nothing into the catalog, its specs or its map, and asks nothing about its calls. It says the repo is a prototype and how to compare it (`prototypeLeftOut`, scanner `facts-catalog.ts`).
- When another repo is written, the estate join never reads a prototype's facts (`productionRepos`, scanner `merge-input.ts`, read by `estateFacts` and `estateFromFacts`). So none of its entries serves, and none of its mocked calls becomes a gap or a question.
- A scan skips a prototype and says why.

The prototype is marked as one wherever it shows: the CLI's lines, the attached document and the app's panel.

### 3. Mocks are the backend the prototype expects

A new reading topic, `mocks` (ADR 0124 addendum A-mocks), tells the assistant how to read:

- **Mocked operations.** Each is a `rest` entry, cited where it is declared, in any of these:
  - an MSW handler;
  - a WireMock mapping;
  - a json-server `db.json` key or `routes.json` line;
  - a Postman mock collection's request;
  - a controller that runs only under `@Profile("mock")`.
- **Fields.** What the mock accepts are `request` field facts, and what it returns are `response` field facts.
- **The mock tool.** Its declaration is a `framework` fact on the mocks' module.
- **Sign-on.** The prototype's SSO configuration gives each BFF route its `auth` (with `authCite`) and its `scopes`, one citation each.

The facts file is unchanged: a mock is an entry, as the gateway's routes are.

An entry is a mock (`isMockEntry`) when any of these is true:

- its file is a mock's (`MOCK_FILE`: a `mocks/`, `__mocks__/`, `stubs/` or `wiremock/` folder, a `mappings/*.json`, `db.json`, `routes.json`, a `.postman_collection.json`);
- its module declares a mock tool (`MOCK_FRAMEWORKS`: MSW, WireMock, json-server, MockServer, Prism, Mirage);
- its citation holds a mock profile line.

The verifier gives a file the `mocks` kind by its path (`fileKinds`), as it does for a gateway's files, and also gives it to a sign-on file (`sso`, `oidc`, `keycloak`, `okta`, `auth0`). A structured mock, such as a WireMock mapping, carries only the mocks' rules.

**Read in the fixture:** MSW and WireMock. **Read by the rule, with no fixture:** json-server, `@Profile("mock")` and Postman.

### 4. The comparison

`comparePrototype` (core `facts-join-prototype.ts`, its own file) takes the prototype's facts, the estate's and the vendors' operations. It places two kinds of call:

- every call the UI makes to its BFF (`ui-bff`);
- every call the BFF makes to a mock (`bff-mock`).

Inside the prototype, a call is paired with the entry it lands on by the join's own path rule (`routeScore`). A call that lands on nothing there is listed as left, with why (for example, a sign-on server's keys). It isn't compared.

Then it adds no second matcher:

- **The estate side is the estate join.** Each call becomes a relative call with no target, in a probe repo of its own, and `joinFacts` joins it: its fallback by method and path, and its walk through gateways.
- **The vendor side is ADR 0130's `joinVendorOperations`.** Each unjoined call becomes a gateway route's forwarding call named to each vendor in turn. The estate's own forwarding calls to that vendor say which gateway the new route goes through.

Each call falls in one of four groups.

| Group       | When                                                                                       | Cites                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **exists**  | the estate serves it as the prototype needs (through the gateway chain where there is one) | the prototype's call and entry; the estate's entry, its Endpoint and how it was found     |
| **changes** | the estate serves the operation, but something differs (see the list below)                | the same, and each difference on both sides                                               |
| **new**     | nothing in the estate serves it and no vendor publishes it                                 | the prototype's call and entry                                                            |
| **vendor**  | only a vendor operation provides it, so it needs a route through the external gateway      | the prototype's; the vendor's spec line; the gateways that forward to that vendor already |

A call is in **changes** when any of these differs:

- a field the prototype sends or reads is missing;
- a field's type differs, compared by family across languages: `BigDecimal` is a number, as `number` is;
- a field's required-ness differs, where both sides state it;
- the prototype's sign-on asks for a scope the estate doesn't demand;
- the auth differs.

Two estate entries that serve a call equally well are listed, under exists, with the question.

Only what the estate says is compared:

- A side the estate's facts name no fields for is unknown, not missing (ADR 0125's rule).
- Scopes are compared only where the estate states some.
- Auth is compared only where both sides cite it.

The comparison is pure and deterministic: the same facts and vendors give the same result in any order. No model is called.

**On the fixture** (`fixtures/prototype-compare/`, invented: the checkout prototype, the Forge shop BFF, billing, the partner gateway and Northwind Pay):

- **Exists:** the UI's `GET /orders/{id}` (the shop BFF, same fields and scope), and the BFF's `POST /invoices/{invoiceId}/pay` to its MSW mock (billing).
- **Changes:** the UI's `POST /checkout`. The shop BFF serves it, but its response has no `loyaltyPoints`, and it doesn't demand the `shop.loyalty` scope the prototype's SSO asks for.
- **New:** the UI's `GET /loyalty/summary`, and the BFF's `GET /loyalty/{sub}/balance` to its MSW mock.
- **Vendor:** the BFF's `GET /v1/charges/{orderId}` to its WireMock mock. Only Northwind Pay's `GET /charges/{chargeId}` provides it, and the partner gateway, which forwards to Northwind Pay already, has no route for it.

### 5. It reaches the change

**`atticus change attach <change> --prototype <repo> [--json]`** compares the prototype and attaches the comparison. It is a flag on the existing attach command, so the top level stays at twelve commands and the census is unchanged.

- The comparison goes in as `inputs/prototype-<repo>.md` (ADR 0113). The feature and architecture stages read it through `changeInputSources`, as data cited by line, so the architecture draft starts from evidence.
- A newer comparison replaces the older one. The same comparison again is said to be unchanged.
- The footprint (B-change's `touches`) gains:
  - the repos whose operations change;
  - the gateways a vendor route goes through;
  - the Endpoints that change, and the vendor operations;
  - their systems and the vendor's.
- The prototype itself is never a repo the change touches.
- `--json` gives `{ prototype, about, comparison, attached, touches, systems }`.

**`GET /api/changes/{id}/prototypes`** (C4 2.30.0, additive) lists each prototype attached to a change, compared again from today's facts. When it can't be compared, it says why. The app's change page shows the four groups, each call cited on both sides, with what differs. The panel has empty, loading and error states, and its words are in the copy file.

The words of the comparison are in `PROTOTYPE_WORDS` (core) and `PROTOTYPE_CLI_WORDS` (CLI). The command, the attached document and the app say the same thing.

## Contract notes

- **C1:** unchanged. A prototype projects nothing.
- **The facts file** (ADR 0124): unchanged. A mock is an `entry`, its fields are `field` facts, and the mock tool is a `framework` fact. The reading protocol gains a topic, `mocks` (addendum A-mocks), and `FACT_RULES`' hash is re-pinned.
- **C4:** 2.30.0, additive: `GET /api/changes/{id}/prototypes` and its schemas.
- **C6:** unchanged. `prototype` is a value of the free repo type.
- **`facts-join.ts`, `facts-join-vendor.ts`:** unchanged. The comparison is its own file.
- **`ChangeTouches`:** unchanged.

## Consequences

- A prototype becomes a cited list of what the change must deliver, split into what is there, what changes, what is new and what a vendor gives. Its footprint is filled in, and the architecture stage reads it.
- The production catalog stays the estate's: nothing a prototype mocks is ever a live Endpoint or a gap.

**Not done here:**

- **Mocks and readers.**
  - No built-in reader recognises mocks. The assistant reads them by the rule; the readers remain an optional cross-check.
  - json-server, `@Profile("mock")` and Postman have no fixture.
- **What the comparison doesn't do.**
  - It doesn't compare a mock's response with what the prototype's BFF reads from it, field by field.
  - It doesn't follow a BFF call that names a host outside the prototype.
  - It doesn't compare enums, error responses or headers.
- **The footprint.**
  - A **new** call adds nothing to the footprint, because where it goes is the architecture stage's to decide.
  - An **exists** call's repo is listed as used, not touched.
- **The app.** The change page lists prototypes attached from the CLI. Attaching one from the app is not built.
