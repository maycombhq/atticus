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
- `expected.yaml`: the gaps the step lists and where the code declares the others. Since S1
  (ADR 0118 addendum) a name is in the code by its declaration only, so `NewOrder`, which the
  controller uses as a parameter's type and nothing declares, is a gap beside Northwind Pay.

A later run (S1, T2, U2) is retold in `known-names.test.ts`:

- `forge-boards/`: a repo with a class, a record and an enum declared in source, a name used
  but never declared, a name in a comment, a Flyway migration, and `docs/REVIEW-PLAN.md`, a plan
  in prose that names classes. The plan is never read as code.
- `pin-a-note/`: a change whose target flows add two endpoints, a target, a table and its
  columns. These are the change's own names, never gaps.

Everything here is invented.
