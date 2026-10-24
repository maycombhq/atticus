# Names that are in the code are not gaps (ADR 0116, 0118)

A live run's architecture step listed the classes of the repo it changes (a controller, a
service, an entity) as "names the change uses that nothing Atticus has read says anything
about". The names came from today's flows, which are read from that code: the expansion
listed each proper name the input uses, and the catalog has no record for a class.

Retold on the stage fixtures' `add-fraud-check` change, with the invented `forge-orders` repo
(`fixtures/specs/repos/forge-orders`) cloned in the workspace and no `northwind-pay` System:

- `expansion.yaml`: the context expander's answer for the architecture step: `OrderController`
  and `NewOrder`, which today's flow names and the repo's code declares, and Northwind Pay,
  which neither the catalog nor the code names.
- `expected.yaml`: the gaps the step lists (only Northwind Pay) and where the code names the
  other two.

Everything here is invented.
