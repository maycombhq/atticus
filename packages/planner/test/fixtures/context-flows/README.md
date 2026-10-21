# Context flows (ADR 0087)

The add-fraud-check change of `fixtures/stages`, touching five flows of which only one changes:
`forge-orders.place-order` gains the Northwind Pay screen; `forge-stock.reserve-stock`,
`forge-orders.cancel-order`, `forge-orders.list-orders` and `forge-stock.release-stock` are only
read. The three extra flows are under `specs/`.

- `feature-answer.yaml`: the feature stage's answer (one flow changed, four read).
- `architecture-empty-deltas.yaml`: the architecture answer in the shape the live dogfood
  showed: the four read flows written as `modify` with no step.
- `architecture-reads.yaml`: the answer the check asks for: the four under `reads`.

Everything here is invented.
