# Design bench

The yardstick for starting a change from a design (revamp plan 4.4): Atticus reads an exported Figma file, finds the screens, fields and actions, maps them to the estate's UI flows and API, and flags every field or action with no backing as a gap.

- `vaccinations.figma.json` is a compact Figma REST export (the shape `GET /v1/files/:key` returns): one canvas, five screen frames, component instances (`Input/Text`, `Input/Date`, `Select`, `Toggle`, `Table`, `Badge`, `Button/Primary` and others) with their labels as `TEXT` children.
- `reference.yaml` is what a correct reading must produce, written by hand from the code at the pinned commits in `../repos.yaml`, never from a scan.

The design is **invented**: a Vaccination records feature for the petclinic estate (spring-petclinic-angular and spring-petclinic-rest). Owners, pets and vets in it are made-up names. Some fields map to data the API already has (owner and pet names, vets from `GET /petclinic/api/vets`), some are new (vaccine, dates, batch number), and some assume data nothing provides (owner email for reminders, clinic location).

## Backing

- `existing`: today's API returns it and a table stores it. `maps_to` names the API field and column.
- `new`: data this feature introduces. `gap` names the column, API field or endpoint to add.
- `unbacked`: the design assumes the data exists somewhere and nothing in the estate provides it.

## Scoring

Against `reference.yaml`, per run:

1. **Screens found**: frames matched by `figma_id`.
2. **Fields and actions found**: matched by `figma_id`; precision and recall like the scan bench.
3. **Backing classified correctly**: share of found fields with the right `backing`, and for `existing` the right `maps_to`. A reading that falls into one of the listed `traps` counts as wrong.
4. **Actions mapped**: share of found actions with the right `existing_endpoint`, or a gap where there is none.
5. **Gaps flagged**: recall over `gaps`; a flagged gap that is not in the list and not a real gap counts against precision.

Nothing reads this bench yet; the design reader and its scorer are not built.
