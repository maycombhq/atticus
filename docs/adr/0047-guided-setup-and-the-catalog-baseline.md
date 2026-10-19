# 0047. Guided setup, the catalog baseline and first-run tours (C4, additive)

- Status: accepted
- Date: 2026-10-19

## Context

The plan's onboarding bars (a platform lead from install to the first map in under an hour, a new team member to their first item in under 15 minutes) need the app to say what to do next. Its setup ends when the architect walks the ecosystem map and accepts the as-is catalog as the baseline, the point every later scan, document and change is compared with. Nothing recorded that acceptance.

## Decision

- **`catalog/baseline.yaml`** (new C4 workspace file, `CatalogBaseline`): who accepted the catalog, when, the record count per kind and the systems, with an optional note. It is committed with the catalog like any other catalog file.
- **`atticus baseline --by <you> [--note text] [--site dir]`** writes it (refused, with "scan first", while the catalog is empty) and can build the read-only catalog site in the same step.
- **`atticus setup [--json]`** lists the steps from install to baseline, each with a plain fix: the org pack is valid, repos are listed, repos are cloned, the first scan is done, groups are mapped to roles, existing knowledge is added (optional), the catalog is accepted. Exit 0 when every required step is done.
- **Local API:** `GET /api/setup` and `POST /api/baseline` (as the signed-in person). When `roles.yaml` names who may make catalog decisions (`approvals.catalog-assert`), only they may accept; otherwise anyone may. Ownership decides, never the view.
- **The app:** Home shows the checklist, with Accept the catalog once a scan is in, until the baseline exists. Each role gets a three-step first-run tour of its home and first task; it opens once per role in a browser, can be skipped, and replays from Help in the top bar.

## Consequences

A new metarepo tells its platform lead what to do next without the guide open. `atticus doctor` (M5) adds environment checks (proxy, TLS, credentials) to the same checklist.
