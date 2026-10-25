# An outside system named by a call fact

Invented Forge facts for `packages/planner/test/carry-findings.test.ts` (ADR 0087 addendum,
2026-10-25), added to the C-join estate in `../facts/` without changing it:

- `forge-customers.jsonl`: customers-api calls a model provider, `llm` (the invented
  `llm.vendor.example`), from POST /api/customers. The call fact names its target, so the
  catalog has an Interface to `llm`, but no Component or System is `llm`: it is an outside
  system, and a target flow's call-out may name it.
