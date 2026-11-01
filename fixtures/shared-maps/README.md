# Another team's map, read-only (ADR 0160, O3)

Invented Forge repos and teams; nothing here is from any real organisation.

- `org-pack/profiles/forge/`: our profile. `forge-risk` is another team's system (boundary
  internal), with the host our services call it on, `risk.forge.internal`, as an alias.
- `repos/forge-lending/` and `facts/forge-lending.jsonl`: our repo. `RiskClient` calls
  `POST /risk/v1/scores` and `POST /risk/v1/fraud-checks` on that host, and
  `GET /v1/limits/{customerId}` naming `forge-risk`. The estate join leaves all three to the system.
- `risk-team/`: the Forge Risk Team's own metarepo, as they would share it. Their manifest puts
  `forge-risk-scoring` on `risk.forge.internal` under `/risk`; their facts hold verified entries
  (`POST /v1/scores`, `GET /v1/scores/{id}`, `GET /v1/limits/{customerId}`), an entry their verify
  never confirmed (its quote carries injected words: left out at import), a field and a call
  (left out), a quote with a secret-looking key (dropped), and a verify report (a companion,
  never read).

Expected: the scores call joins `forge-risk-scoring`'s `POST /v1/scores`, the limits call
`forge-risk-limits`' entry, and the fraud check is `not-in-shared-map`. Pinned in
`packages/core/test/shared-maps.test.ts`, `packages/scanner/test/shared-maps-catalog.test.ts` and
`packages/cli/test/shared-cli.test.ts`.
