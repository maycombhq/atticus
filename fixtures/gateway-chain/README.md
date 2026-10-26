# A call through two gateways, with the scopes each one demands (invented)

ADR 0124 addendum A-gateway2. Everything here is made up: Forge is an invented company and
Northwind Pay an invented vendor. Six repos, read by hand into facts the way `/atticus-map` asks:

| Repo | What it holds |
| --- | --- |
| `repos/forge-shop-bff` | The shop's back end for its front end: a `RestClient` calling the edge gateway at `/forge/v2/...`, its base URL in `application.yml` |
| `repos/forge-edge-gateway` | The internal Apigee gateway (`type: gateway`). Proxy `forge-orders-v2` (base path `/forge/v2`, virtual host `internal`, a SpikeArrest, two conditional flows: `GetOrder` with an `OAuthV2` demanding `orders.read`, `DispatchOrder` with an `OAuthV2` demanding `orders.dispatch orders.write` and an AssignMessage that rewrites the path); proxy `forge-pay-v1` (base path `/forge/pay/v1`, virtual host `internal`, an `OAuthV2` demanding `payments.charge`, an AssignMessage that rewrites the path, forwarding into the partner gateway); the prod and dev TargetServers; and the `forge-loop-v1` proxy of the cycle case |
| `repos/forge-orders` | The orders service: it serves `/orders/{id}` and `/dispatch`, and its dispatch handler calls Northwind Pay at `/forge/pay/v1/charges`, on its way out through both gateways |
| `repos/forge-partner-gateway` | The external Apigee gateway (`type: gateway-external`). Proxy `northwind-pay-v1` (base path `/pay/v1`, virtual host `external`, an `OAuthV2` demanding `northwind.charges.write`, a target `<Path>/v2</Path>`), the prod TargetServer `northwind-pay`, and the `northwind-loop-v1` proxy of the cycle case |
| `repos/northwind-pay-api` | Northwind Pay's charge API, `POST /v2/charges`, reached only through the partner gateway |
| `repos/forge-orders-sandbox` | The orders sandbox on the host the edge gateway's **dev** TargetServer names: the ambiguous-host case's other candidate |

`facts/` holds what a reader writes for each repo (verified against `repos/` in
`packages/verify/test/gateway-scopes.test.ts`); `expected/join.yaml` is the join, written by hand.

## The chain

One hop, in: `shop-bff` calls `POST /forge/v2/orders/{id}/dispatch`. It lands on the edge
gateway's `DispatchOrder` route (oauth2, `orders.dispatch` and `orders.write`, **internal**),
which rewrites the path and forwards `POST /dispatch` to the orders service.

Two hops, out: the orders service's dispatch handler calls `POST /forge/pay/v1/charges`. It lands
on the edge gateway's `CreateCharge` route (oauth2, `payments.charge`, **internal**), which
rewrites the path and forwards `POST /pay/v1/charges` to the **partner gateway**, where it lands
on its `CreateCharge` route (oauth2, `northwind.charges.write`, **external**) and is forwarded as
`POST /v2/charges` to Northwind Pay. So that one join keeps two hops, in order, each with its own
auth and scopes, and each marked internal or external from its proxy's `<VirtualHost>` and its
repo's manifest type.

End to end the estate reads `shop` → gateway → `orders` → gateway → gateway → `northwind-pay`:
each join keeps the hops its own call passes through.

## The cases

- **A cycle.** `forge-loop-v1` on the edge gateway forwards to `northwind-loop-v1` on the partner
  gateway, which forwards back to `forge-loop-v1`. The walk is bounded and asks a question rather
  than looping.
- **An ambiguous host.** `cases/ambiguous-host.jsonl` is the edge gateway's **dev** TargetServer
  `orders-backend`, whose host `forge-orders-sandbox` answers on while the prod one is
  `forge-orders`'. Added to the edge gateway's facts, the forwarding call is asked, never guessed,
  and the chain stops at the first gateway.

Files here are byte-exact: facts cite their line numbers.
