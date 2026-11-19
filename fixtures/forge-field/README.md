# forge-field: the field-shaped Forge estate, as a fixture

Beta.30 (slice 9). The estate `packages/cli/test/field-estate.ts` makes, at the shape and options
of `packages/cli/test/forge-field.ts`, written once so the journeys and the CLI suites seed it as
fast as the tidy Forge fixture (`fixtures/forge/metarepo`). Everything is invented: Forge is an
invented company, Northwind Pay an invented vendor (CLAUDE.md rule 3).

Don't edit these files by hand. Regenerate them, then review the diff:

    node scripts/write-field-fixture.mjs        (pnpm fixtures:field)

`packages/cli/test/forge-field-fixture.test.ts` fails when they are out of date with the code.

| Folder or file | What it is                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `metarepo/`    | The metarepo after the upgrade: org pack, facts and snapshots, legacy slots, corrections, curated |
| `repos/`       | The files of the repos with a clone; seeding makes each a git repo at the commit its facts cite   |
| `estate.json`  | What the tests look for: the repos, the topic, the wrong box, the commits, the change             |

The shapes it holds, each one a field report named:

| Shape                                       | Where                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Gateway proxies whose target is a token     | `forge-gw-00`, `forge-gw-01` (`@targetUrl@`), `forge-gw-02` (`${TARGET_URL}`), set per env |
| Calls to a deploy token nothing sets        | The services' calls to `@forgeTargetUrlN@`: loose ends the join asks about                  |
| A repo with no System                       | `forge-nosystem-svc`                                                                        |
| An id with dots                             | `forge.instruments.svc`                                                                     |
| Nested payload fields                       | `forge-nested-svc` (`customer.address.city`, `items[].sku`)                                 |
| ssh and https origins                       | The manifest, one of each in turn                                                           |
| A non-gateway callee, hand pairings         | `facts/*.corrections.jsonl`: pat's pairings with the next service                           |
| A legacy slot from before the upgrade       | `forge-svc-04` (`catalog/sources/readers/`, `catalog/sources/legacy/joins.json`)            |
| An empty repo, a repo nobody read           | `forge-deploy` (its clone is an empty `.git`), `forge-audit` (no clone, no facts)           |
| A topic with consumers in two repos         | `forge.items.settled`: `forge-svc-02` publishes, `forge-svc-03` and `forge-svc-00` listen   |
| A call joined to the wrong box              | `estate.json` `wrongBox`: as fixtures/reconnect, its API also served where it really goes   |
| A change on the quick path                  | `openspec/changes/publish-settled-refunds` (the archetypes' new event, its files written)   |

The rule (CONTRIBUTING.md, "Adding a field report's shape"): a field report adds its shape to the estate, as an invented
Forge shape, before its fix.
