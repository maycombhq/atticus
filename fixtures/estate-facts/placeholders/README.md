# Config placeholders resolved through the config that sets them (J0)

Invented Forge facts for `packages/core/test/facts-join-placeholders.test.ts`. A Spring service on
OpenShift names its callees' base URLs as `${VARIABLE}` in `application.yml`; the value is set in
its own `openshift/configmap.yaml` or in a config repo's Helm values per environment.

- `forge-pay.jsonl` (component `pay-api`): five calls whose bases are placeholders.
  - `forge.payments.url: ${PAYMENTS_URL}`, set in `forge-config` for `apps/pay-api/` in dev (a host
    nobody lists) and prod (the shared platform host under `/forge/payments`, which
    `forge-payments` lists with its base path). Joined by host, citing the prod line only.
    `apps/statements-api/values.yaml` sets `PAYMENTS_URL` too, for another component, and is not
    read for `pay-api`.
  - `forge.limits.url: ${LIMITS_URL:http://localhost:8082}`, set in the repo's own ConfigMap: the
    ConfigMap's value wins over the Spring default.
  - `forge.ledger.url: ${LEDGER_URL:https://ledger.forge.internal}`, set nowhere: the default is
    the value, cited on its own line.
  - `forge.risk.url: ${RISK_URL}`, set to hosts two different repos list (dev `forge-risk`, prod
    `forge-risk-v2`): asked, never one of them taken.
  - A publish to `${forge.topics.payment-made}`, set in the same `application.yml`.
- `forge-config.jsonl`: the config repo, one folder per component (`apps/<component>/`).
- `forge-ledger.jsonl`: listens on `${LEDGER_PAYMENTS_TOPIC}`, set in
  `forge-config/apps/ledger-api/configmap.yaml` to the topic `pay-api` publishes.
- `forge-payments`, `forge-limits`, `forge-risk`, `forge-risk-v2`: the entries the calls reach.

The manifest the test gives: `forge-payments` on `apps.ocp.forge.internal` with base path
`/forge/payments`, `forge-limits` on `limits.apps.forge.internal`, `forge-ledger` on
`ledger.forge.internal`, `forge-risk` on `risk.apps.forge.internal`, `forge-risk-v2` on
`risk-v2.apps.forge.internal`.
