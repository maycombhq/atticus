# A beta.26 Forge metarepo's catalog (ADR 0195, ticket CS5)

The upgrade path's fixture: the catalog of the invented Forge estate as a team has it before beta.27. `catalog/generated/` was written by a full scan, with the curated decisions applied, and there is no `catalog/sources/` and no `build.json`. Copy it over `fixtures/forge/metarepo/` to get the metarepo `atticus upgrade` adopts.

| File | What it is |
| --- | --- |
| `catalog/generated/` | Every record the Forge golden slots (`fixtures/forge/slots/readers/`) build to, with the curated decision below applied: a full beta.26 scan's catalog. |
| `catalog/generated/setting/portal-bff.ledger-read-timeout.yaml` | One hand edit: `valueOrRef` raised from `2000ms` to `5000ms`, as a team did before beta.27 (the next scan would have undone it). The upgrade adopts it as it is. |
| `catalog/curated/curateddecision/cd-ledger-api-migration.yaml` | A curated assert (`migration: in-progress` on `ledger-api`), applied in `catalog/generated/component/ledger-api.yaml`. |
| `curated/` | The same decision, as the input `catalog/` is made from. |

`packages/cli/test/slots-journeys-cli.test.ts` makes `catalog/` again and checks every byte; `UPDATE_GOLDEN=1` rewrites it after a review (the readers' or the build's output changed). Everything here is invented (CLAUDE.md rule 3).
