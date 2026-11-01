# Spec seed fixtures (ADR 0146)

The verified flows of the invented `forge-orders` and `forge-stock` repos, as `atticus verify --write` projects them into `specs/<repo>/`: `forge-orders.place-order` (a call-out, a branch, a write and two error cases), `forge-orders.list-orders` (no errors, a trigger with no endpoint record) and `forge-orders.old-export` (retired, so never seeded).

`expected/` holds what `atticus spec seed forge-orders` writes into `openspec/changes/seed-forge-orders/`: each capability's `spec.md` and the `proposal.md`.

`collision/hold-big-orders.spec.md` is a change's spec delta (the change `hold-big-orders`) that adds `forge-orders.place-order` as a new capability while the seed `seed-forge-orders` is still open: the two would collide at archive (ADR 0156).
