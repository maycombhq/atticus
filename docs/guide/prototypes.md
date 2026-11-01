# Starting from a prototype

Your team may have a working prototype: a UI, its BFF, single sign-on wired in, and the backend mocked. It says exactly what the change must deliver. Its screens' calls say what the UI needs, and its mocks say what the backend must provide.

Atticus reads the prototype and compares it with your estate. Every call is placed in one of four groups, each cited:

- **Exists.** The estate already serves it as the prototype needs, through your gateways where there are any.
- **Changes.** The estate serves the operation, but not as the prototype needs. Atticus says what differs:
  - a field missing, or a field's type or required-ness;
  - an enum value one side lists and the other doesn't: a value the prototype sends that the estate doesn't take, one it expects that the estate never returns, or one the estate may return that the prototype doesn't handle;
  - a header the prototype sends or reads that the estate doesn't, or one the estate requires that the prototype doesn't send;
  - an error the prototype expects that the estate never answers, or one the estate answers that the prototype doesn't handle;
  - a scope the sign-on asks for that the estate doesn't demand, or the auth.
- **New.** Nothing in the estate serves it, and no vendor or other team publishes it.
- **Only a vendor.** Only a vendor's published operation provides it, so it needs a route through your external gateway. Atticus names the gateway that forwards to that vendor already. When the operation is **another team's** (their spec is in `inputs/`, and their system is in the profile with no repo of yours), Atticus says so: the change calls it as they publish it, and names the repos that call it already.

Only what both sides say is compared. A side that lists no enum values, no headers or no errors is unknown, not different. Enum values come from a field's type when it lists them (`"captured" | "failed"`, `ChargeStatus(CAPTURED|FAILED)`) or from a spec's `enum`; headers are the fields named as headers (`Idempotency-Key`, `X-Request-Id`) or a spec's header parameters; errors are the statuses (`409`) a flow's error paths name, or a spec's 4xx and 5xx responses.

The design decisions are [ADR 0133](../adr/0133-a-prototype-compared-with-the-estate.md) and [ADR 0142](../adr/0142-a-prototype-compared-further-and-another-teams-spec.md).

## 1. Add the prototype as a repo of type `prototype`

Add it to the manifest with `type: prototype`, and say in one line what it is:

```
atticus repo add https://git.example.com/forge/forge-checkout-prototype.git --type prototype --owner team-shop --description "A clickable prototype of checkout with loyalty points"
```

A prototype is read like any repo, but it is never part of the production catalog:

- it gives no Endpoints and no Interfaces;
- none of its mocked calls becomes a gap or a question;
- another repo's calls never join it.

## 2. Read it, and verify what was read

```
atticus workspace sync
/atticus-map forge-checkout-prototype
atticus verify forge-checkout-prototype --write
```

Your assistant reads the prototype as it reads any repo. It also follows the reading rule for mocks:

- each mocked operation is an entry, with the fields it accepts and returns;
- the sign-on configuration gives each BFF route its auth and scopes.

The verifier checks every claim on its line, as it does for any repo. `--write` keeps the facts and says the repo is a prototype; nothing goes into the catalog.

**Mock tools.** The rule covers MSW handlers, WireMock mappings, json-server's `db.json` and `routes.json`, Postman mock collections, and a Spring controller that runs only under `@Profile("mock")`. MSW and WireMock are tested on a fixture; the others are read by the rule.

## 3. Compare it, and attach the comparison to a change

```
atticus change attach loyalty-at-checkout --prototype forge-checkout-prototype
```

This prints the four groups, each call cited on both sides (the prototype's line, and the estate's or the vendor's), with what differs. Then it does three things:

- **It attaches the comparison** as `inputs/prototype-forge-checkout-prototype.md`. The feature and architecture stages read it as data and cite it by line, so the architecture draft starts from evidence. Run the command again after the prototype or the estate changes: the newer comparison replaces the older one.
- **It lists the new calls for the architecture stage.** The attached comparison ends with **New calls, for the architecture stage**: each call nothing serves, with the fields it sends and reads, cited. `atticus change architecture` gives the drafter that list and tells it to place every call: the entry that will serve it, in a new or changed flow, or why it isn't built in this change.
- **It fills in the change's footprint:** the repos whose operations change, the gateway a vendor route goes through, the Endpoints that change, the vendor operations, and their systems. The prototype itself is never a repo the change touches.

`--json` gives the comparison as data.

**Vendor and team specs.** For the vendor group, add the vendor's spec, or another team's, to `inputs/` first (`atticus intake add`). See [A vendor's API changes](vendor-specs.md).

## In the app

A change's page shows **The prototype, compared**: each prototype attached to the change, compared again from today's facts, in the four groups. If a prototype can't be compared any more, the page says why. For example, its facts may no longer be verified.

## What it doesn't do yet

- It doesn't compare a vendor's response headers, or `oneOf` and `anyOf` bodies.
- A call that is **new** adds nothing to the footprint. Where it goes is the architecture stage's to decide, and that stage is given the list.
- The app shows prototypes. To attach one, use the command.
