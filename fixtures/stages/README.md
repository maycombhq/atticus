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

`small/` is the fast path (ADR 0113): `return-order-time/`, a small change (type
`small-change`) whose order response returns when the order was placed; `answer.yaml`, the one
answer an assistant gives it; `knowledge.yaml`, a standard the task context finds for its step;
and `expected/`, the tasks.md it writes and the task context of its task 1.1. The tests copy it
in themselves, so the stage tests above don't see it.

`lenses/checklists/stage-review.yaml` holds two AI rules at the define gate, one for the
business lens and one for the architecture lens (ADR 0115). The hand-off lens tests copy it into
the org pack so the critic's AI lenses review the feature stage's draft; the other tests don't.

`pin-note/` is the pinned-note scenario (ADR 0115 and 0117 addenda, 2026-10-24): the change
`pin-order-note` ("pin an order note"), a blocking business-lens rule (`checklists/pin-review.yaml`)
and `scenario.yaml`: the question a person answers, the same question asked again in other
words, one the answer leaves open, and the lens finding about the narrowing the person chose. The
tests copy it in themselves.

`pin-table/` is the new-table scenario (ADR 0087, 0111 and 0115 addenda, 2026-10-24). It holds
the change `pin-order-note` with its feature placed: two new flows in `forge-orders` that use one
new table, `forge-orders-db.order_pin`. `catalog.yaml` adds forge-orders-db's three Flyway
migrations. `drafts/` holds the architecture answers: `live.yaml` as a live run wrote it (every
flow change marks the table new and restates part of it); `undecided.yaml`, with retention and
two classifications left to a person; `sends-extra.yaml` and `sends-extra-no-retention.yaml`, with
a field sent and never stored; and `answered.yaml`, which is right. `expected/live-findings.yaml`
holds the findings the checks give `live.yaml`. The tests copy it in themselves.

Everything here is invented.
