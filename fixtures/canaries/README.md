# Canaries (invented)

Plan item Z2, ADR 0196. Everything here is made up: Forge is an invented company. Three invented
repos, one per stack the canary templates cover, read by hand into verified facts:

| Repo | Its code | Facts |
| --- | --- | --- |
| `forge-portal-bff` | Spring on Java: `repos/forge-portal-bff` | `facts/forge-portal-bff.jsonl` |
| `forge-portal-ui` | TypeScript, a browser app: `fixtures/forge/repos/forge-portal-ui` | `facts/forge-portal-ui.jsonl` |
| `forge-appraise` | Python, FastAPI: `fixtures/reachable/forge-appraise` | `facts/forge-appraise.jsonl` |

- `repos/forge-portal-bff`: the Forge BFF (`fixtures/forge/repos/forge-portal-bff`) with what a
  canary needs to plant all five of Spring's items: a `pom.xml` that declares the web and Kafka
  libraries, and a `@SpringBootApplication` class to plant beside. Its facts are the same.
- `expected/<repo>.s1.json`: the canary plan for each with seed `s1` (what is planted where, what
  the repo can't serve and so isn't planted, and which real lines are commented out), checked by
  hand; `packages/verify/test/canary.test.ts` holds the plan to it. The browser app gets a call
  only (to a path of its own origin): no route and no topic (it declares no server and no Kafka
  client), and no config key (a browser has no `process.env`); the Python service gets no topic
  (no Kafka client). Each removed line's needle is its method and path (`get api-balance-param`)
  or its key, so a correct fact on the line beside it is never scored as claiming it.
- `reads/forge-portal-bff.s1.jsonl`: a read of the planted copy (seed `s1`) written by hand, as an
  assistant might write it, since no model runs in tests: it finds four of the five planted items
  and misses the listener, and claims the three commented-out lines. The verifier catches all
  three, the third (a `cite.with` part naming a value only the commented-out line beside it holds)
  since the review of ADR 0196; before, it kept it, the canary's first finding.
  `facts/forge-portal-bff.audit.yaml` is a sample audit with one wrong answer of nine.
  `packages/cli/test/canary-cli.test.ts` scores them: recall 4 of 5, the audit misread rate 1 of 9
  and the canary pass-through rate 0 of 3, side by side.
