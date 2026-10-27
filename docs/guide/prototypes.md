# Starting from a prototype

Your team may have a working prototype: a UI, its BFF, single sign-on wired in, and the backend mocked. It says exactly what the change must deliver. Its screens' calls say what the UI needs, and its mocks say what the backend must provide.

Atticus reads the prototype and compares it with your estate. Every call is placed in one of four groups, each cited:

- **Exists.** The estate already serves it as the prototype needs, through your gateways where there are any.
- **Changes.** The estate serves the operation, but not as the prototype needs. Atticus says what differs: a field missing, a field's type or required-ness, a scope the sign-on asks for that the estate doesn't demand, or the auth.
- **New.** Nothing in the estate serves it, and no vendor publishes it.
- **Only a vendor.** Only a vendor's published operation provides it, so it needs a route through your external gateway. Atticus names the gateway that forwards to that vendor already.

The design decision is [ADR 0133](../adr/0133-a-prototype-compared-with-the-estate.md).

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

This prints the four groups, each call cited on both sides (the prototype's line, and the estate's or the vendor's), with what differs. Then it does two things:

- **It attaches the comparison** as `inputs/prototype-forge-checkout-prototype.md`. The feature and architecture stages read it as data and cite it by line, so the architecture draft starts from evidence. Run the command again after the prototype or the estate changes: the newer comparison replaces the older one.
- **It fills in the change's footprint:** the repos whose operations change, the gateway a vendor route goes through, the Endpoints that change, the vendor operations, and their systems. The prototype itself is never a repo the change touches.

`--json` gives the comparison as data.

**Vendor specs.** For the vendor group, add the vendor's spec to `inputs/` first (`atticus intake add`). See [A vendor's API changes](vendor-specs.md).

## In the app

A change's page shows **The prototype, compared**: each prototype attached to the change, compared again from today's facts, in the four groups. If a prototype can't be compared any more, the page says why. For example, its facts may no longer be verified.

## What it doesn't do yet

- It doesn't compare enums, error responses or headers.
- A call that is **new** adds nothing to the footprint. Where it goes is the architecture stage's to decide.
- The app shows prototypes. To attach one, use the command.
