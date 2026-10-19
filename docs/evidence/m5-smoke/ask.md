**Only one system calls ledger-api: `portal-bff`.** It reaches ledger-api in three ways, and all three records are `status: current` and `confidence: verified`.

| Caller | How | Interface | What it calls |
|---|---|---|---|
| portal-bff | sync REST via gateway route `gw-ledger-v1` (`/ledger/v1`), OAuth2 | `if-75b5e8d8aa780837` | `GET /accounts/{}/balance` (`ledger-api.get-balance`) |
| portal-bff | sync REST via gateway route `gw-ledger-v1`, OAuth2 | `if-d99f508a2ac9b6e0` | `POST /transfers` (`ledger-api.post-transfer`) |
| portal-bff | async, publishes `payments.initiated` on the event bus; ledger-api is the consumer | `if-32d38aecd11b86b1` | topic `payments-initiated` |

**Evidence**
- **Gateway calls:**
  - The caller side is `forge-portal-bff` at `src/main/java/forge/portal/LedgerClient.java`, line 8 for get-balance and line 11 for post-transfer.
  - The gateway side is `forge-gateway` at `proxies/ledger-v1/apiproxy/proxies/default.xml:9`.
  - The callee side is `forge-ledger` at `src/main/java/forge/ledger/LedgerEndpoints.java`, line 8 for get-balance and line 11 for post-transfer.
- **Event:** The caller side is `forge-portal-bff` at `src/main/java/forge/portal/PaymentEvents.java:11`. The topic definition is `forge-events` at `topics/payments.initiated.yaml:1`. The callee side is `forge-ledger` at `src/main/java/forge/ledger/LedgerEvents.java:6`.
- **Route:** `gateway-route/gw-ledger-v1.yaml` shows the route enforces `VerifyOAuth` and `SpikeArrest`, requires scopes `ledger.read` and `ledger.write`, and targets `http://ledger-api.forge.internal`.

**Related, but not callers**
- ledger-api calls out to `northwind-pay` (`POST /v2/payments`, `if-e7344c9455608119`).
- ledger-api publishes `transfers.completed`, which `reports-job` consumes (`if-f1cd1f189eaa4b7b`). reports-job consumes ledger-api's event but doesn't call it.

**Gaps**
- Only callers that show up as Interface records appear here. The catalog has no record of anything else calling ledger-api, such as direct in-cluster calls that skip the gateway. The `target` URL is internal, so that is possible. I can't confirm it either way. The owner of the `ledger` system (`system/ledger.yaml`) would know.
- The `pattern` codes on these interfaces are `inferred`, not verified. They don't affect who calls whom.

**Records used (under `catalog/generated/`):**
- `interface/if-75b5e8d8aa780837.yaml`
- `interface/if-d99f508a2ac9b6e0.yaml`
- `interface/if-32d38aecd11b86b1.yaml`
- `interface/if-e7344c9455608119.yaml`
- `interface/if-f1cd1f189eaa4b7b.yaml`
- `component/ledger-api.yaml`
- `gatewayroute/gw-ledger-v1.yaml`
