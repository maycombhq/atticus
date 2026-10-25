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

`hold-stock/` is the architecture checks scenario (ADR 0124 addendum B-arch): the change
`hold-stock` ("hold stock instead of reserving it"), placed on both repos' flows.
`catalog.yaml` adds who uses what it touches: forge-web calls POST /orders (an Interface) and
forge-reports reads the orders table (the Table's readers). `drafts/` holds the architecture
answers: `no-consumers.yaml`, whose two breaking changes (the reservation response drops
reservationId; quantity widens from INT to BIGINT) list no consumers and which gives no deploy
order; `wrong-order.yaml`, which deploys forge-orders before its migration and before
forge-stock; and `clean.yaml`, which is right. `expected/` holds the findings of the first two
and the sections design.md gains from the third. The tests copy it in themselves.

`stories/` is the fraud check's story with every section of a professional story (ADR 0124
addendum B-stories): `placed.yaml` and `deltas.yaml`, the feature and architecture answers;
`answer.yaml`, the story writer's answer with context, scope, interface and data changes,
non-functional notes, test notes and dependencies; and `expected/s1-place-order.md`, the story
file the stage writes from it, with a build command from a repos manifest the test writes.

`stories-units/` is the order summary (ADR 0124 addendum B-tasks): a one-page feature that came
out too fine, as a real change did. `catalog.yaml` and `flows.yaml` are forge-orders, forge-web
and forge-gateway, with an existing flow (`forge-orders.draft-reply`) whose AssistantClient
reserves the spend, calls the invented vendor Northwind Models and settles the spend.
`deltas.yaml` holds a new server flow of twelve steps (one placed with `at`), a web story and a
gateway route story; `answer.yaml` is the story writer's answer written per step (17 steps, 28
criteria). The tests build the estate from them in memory.

`stories-bench/` is the stories bench's conversion (B-stories-bench): `stories.yaml`, the stories
the stage works out for the fraud check from `stories/deltas.yaml`; `expected/forge-fraud-check.yaml`,
the `BenchStory` draft `atticus bench stories --change` makes of them and `stories/answer.yaml`;
and `bench/stories/forge-fraud-check.yaml`, an invented reference story (with a forge-web
checkout step the draft lacks) to score it against.

`stories-once/` is a criterion written once (ADR 0124 addendum B-once): `stories.yaml`, a story
whose four tasks pass an order's `deliverBy` through the entry, a new validation, the write and
the response; `repeated.yaml`, its answer with criteria repeated per task (8); and `answer.yaml`,
the same with each behaviour written once and `also` naming the other tasks it accepts (4).

`wiki/` is the knowledge each stage picks (B2, 2026-10-25): `snapshots/forge-wiki/2026-10-01/`, a
snapshot of three invented wiki pages (Northwind Pay's fraud screen, whose timeouts and verdict
webhook no item covers; vendor onboarding; the integration standards), and `knowledge.yaml`, a
standard with its rules (`outbound-call-timeouts`) and two integration patterns read from those
pages (`vendor-partner-gateway`, and `managed-file-transfer`, which shares no words with the
fraud check). `packages/planner/test/stage-knowledge.test.ts` copies it in itself.

Everything here is invented.

`corrections/` is the drafted-against-merged scenario (H1 to H3, ADR 0087 addendum, 2026-10-25).
`changes/archive/` holds three archived Forge changes whose kept pairs (`stage/<stage>.drafted/`,
`.merged/` and `.capture.yaml`) needed fewer edits each time: `screen-orders` (feature,
architecture and stories, many edits), `bulk-orders` (one line in the feature, one criterion
reworded) and `reserve-later` (merged as drafted). `changes/restock-alert/` was merged on the
host but isn't pulled yet (`waiting-for-merge`). `expected/learn.json` and `expected/learn.txt` are
the report `atticus change learn` gives for them. `answers/` holds the three stage answers for the
fraud check, which the past-corrections test drafts with and without the archive beside it.

`carry/` is what a real change's run hit (ADR 0087 addendum, 2026-10-25): two placements of the fraud
check (the first caches the verdict by order id alone and asks a question; the second keys it by
the data version too), the true lens's blocking finding on the first, and the complete lens's risk
finding. See `carry/README.md`.
