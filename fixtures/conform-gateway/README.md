# Code against design on a gateway estate (eighth UX walk, invented)

Everything here is made up: Forge is an invented company. The change "Let tellers lock a card
from the branch" (`let-tellers-lock-a-card`) on the four repos of
`../link-estate/gateway-questions`, whose facts were read at each repo's base commit. Its task
branches change the very files those facts cite, so a scan of a branch carries none of them (or
only an unrelated config fact), and the new code has no facts yet. The check (ADR 0114) must not
call the new Apigee flow or the teller's `config.getUri("core-gateway") + path` call missing on
the readers' word: rule 4 says facts decide and the readers are a cross-check.

| Folder | What it holds |
| --- | --- |
| `change/` | The change folder: `change.yaml`, the three target flows (card vault's lock route, the proxy's new `LockCard` flow forwarding to the vault, the teller app's lock call through the gateway) and the stories that say which task builds which step |
| `after/forge-proxy-core-v1/` | The proxy after task 2.1: `apiproxy/proxies/default.xml` with the `LockCard` flow |
| `after/forge-teller-app/` | The teller app after task 3.1: `TellerClient.java` with `lockCard`, calling `config.getUri("core-gateway") + "/forge/core/v1/cards/" + card + "/lock"` |

Tests: `packages/taskrun/test/conform-gateway.test.ts` (git branches made by the test, the real
scan) and `packages/planner/test/conform.test.ts` (the check on the records alone).
