# Placeholders set through `valueFrom`, and two placeholders in one value (J0 follow-up)

Invented Forge facts for `packages/core/test/facts-join-value-from.test.ts`. A Spring service on
OpenShift names a callee's base URL as `${PAYMENTS_URL}`; its Deployment sets the variable with
`valueFrom: configMapKeyRef: {name: payments-config, key: payments.url}`, and the ConfigMap
`payments-config` holds the URL. The reader writes the env entry as a config fact whose `source`
is `configMapKeyRef:payments-config/payments.url`, cited on the `- name:` line with the `name:`
and `key:` lines in `cite.with`, and each ConfigMap entry with its `metadata.name` line in
`cite.with`.

- `forge-wallet.jsonl` (component `wallet-api`):
  - `forge.payments.url: ${PAYMENTS_URL}`, set in `openshift/deployment.yaml` from
    `payments-config`'s `payments.url` (`openshift/configmap.yaml`). `batch-config`'s
    `payments.url` (`openshift/configmap-batch.yaml`) is another ConfigMap's and is not followed.
  - `forge.ledger.url: ${LEDGER_URL}`, set in the deploy repo (`forge-deploy`) from
    `ledger-config`, whose file is named for it (`apps/wallet-api/ledger-config.yaml`).
  - `forge.limits.url: ${LIMITS_SCHEME}://${LIMITS_HOST}/v1`: each set once, so resolved.
  - `forge.risk.url: ${RISK_SCHEME}://${RISK_HOST}`: `RISK_HOST` has a dev and a prod value, so
    the value is left unresolved.
  - `forge.fraud.url: ${FRAUD_URL}`, set from the Secret `fraud-credentials`, whose values are
    never facts: not resolved.
- `forge-deploy.jsonl`: the deploy repo, one folder per component (`apps/<component>/`).
- `forge-payments`, `forge-ledger`, `forge-limits`, `forge-risk`, `forge-risk-v2`, `forge-fraud`:
  the entries the calls reach.

The manifest the test gives: `forge-payments` on `payments.apps.forge.internal`, `forge-ledger` on
`ledger.forge.internal`, `forge-limits` on `limits.apps.forge.internal`, `forge-risk` on
`risk.apps.forge.internal`, `forge-risk-v2` on `risk-v2.apps.forge.internal`, `forge-fraud` on
`fraud.apps.forge.internal`.
