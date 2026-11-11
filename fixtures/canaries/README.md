# Canaries (invented)

Plan item Z2, ADR 0196. Everything here is made up: Forge is an invented company. Three invented
repos, one per stack the canary templates cover, read by hand into verified facts:

| Repo | Its code | Facts |
| --- | --- | --- |
| `forge-portal-bff` | Spring on Java: `fixtures/forge/repos/forge-portal-bff` | `facts/forge-portal-bff.jsonl` |
| `forge-portal-ui` | TypeScript: `fixtures/forge/repos/forge-portal-ui` | `facts/forge-portal-ui.jsonl` |
| `forge-appraise` | Python, FastAPI: `fixtures/reachable/forge-appraise` | `facts/forge-appraise.jsonl` |

- `expected/<repo>.s1.json`: the canary plan for each with seed `s1` (what is planted where, and which
  real lines are commented out), checked by hand; `packages/verify/test/canary.test.ts` holds the
  plan to it.
- `reads/forge-portal-bff.s1.jsonl`: a read of the planted copy (seed `s1`) written by hand, as an
  assistant might write it, since no model runs in tests: it finds four of the five planted items
  and misses the listener, claims two of the commented-out lines (the verifier catches both) and
  claims the third through a `cite.with` part beside the comment (the verifier keeps it: a silent
  error). `facts/forge-portal-bff.audit.yaml` is a sample audit with one wrong answer of nine.
  `packages/cli/test/canary-cli.test.ts` scores them: recall 4 of 5, the silent error rate 2 of 14.
