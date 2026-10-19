# Release fixtures

Hand-written overlays on `fixtures/forge-change` (the seeded change `add-transfer-limit` at plan), laid down by `test/helpers.ts`. Never regenerate them from the code under test.

| Folder | What it holds |
| --- | --- |
| `released/` | Files laid over the change folder for a change further along: a design.md with rollback, readiness, verification and hypercare sections; snow.md with the record in the heading and the target filled; a filed request (`sync.yaml` and the done step in `steps/`); a design round with a waived finding and an AI lens; a plan round with an open release-lens finding; an empty drift round; a task run summary |
| `initiative/` | A curated initiative `daily-limits` that holds `add-transfer-limit`, and its plan with a gateway request, the build and the release-ready milestone (target release 2026-11-13) |

The golden files in `test/golden/` are the expected outputs for the plain fixture at `2026-10-21T09:00:00Z` (a Wednesday), checked by hand against the change folder, the Forge org pack and the Forge expected catalog.
