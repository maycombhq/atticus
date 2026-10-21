# Stage fixtures (ADR 0087)

A small two-repo estate for the change lifecycle's three stages: the invented `forge-orders` and
`forge-stock` repos (catalog from `../specs/catalog.yaml` plus `catalog-extra.yaml`), one spec
flow per repo under `specs/`, three knowledge items (`knowledge.yaml`), the invented vendor
Northwind Pay, and two open changes:

- `add-fraud-check`: the change the tests take from feature to tasks.
- `bulk-orders`: another change in flight that also changes `forge-orders.place-order`, so the
  feature stage reports a conflict.

`order-form.figma.json` is a one-screen design export for the Figma entry.
`expected/requests.md` is the requests file the stories stage writes for the fraud check.
Everything here is invented.
