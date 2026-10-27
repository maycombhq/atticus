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

## Who calls a route (ADR 0124 addendum A-callers)

A seventh repo, `repos/forge-refunds`, is the Spring-shaped refunds service behind the edge
gateway's `forge-refunds-v1` proxy (base path `/forge/refunds/v1`, virtual host `internal`, two
flows: `CreateRefund` demanding `refunds.write`, `GetRefund` demanding `refunds.read`, both
forwarding by `<URL>` to `refunds.forge.internal`). Its refund goes straight out through the
partner gateway's `northwind-refunds-v1` proxy (`external`, `northwind.refunds.write`) to Northwind
Pay's `POST /v2/refunds`.

Nothing scanned calls the `forge-refunds-v1` routes. The edge gateway's own files name who may:
`resources/edge/org/apiProducts.json` lists the API product `forge-refunds` for that proxy, and
`resources/edge/org/developerApps.json` subscribes two developer apps to it, `harbor-desk-portal`
and `forge-ops-console`; the routes' facts cite each as a `callers` entry. Harbor Desk, another
team's product whose repo is never scanned, is declared in `org-pack/profiles/forge/profile.yaml`
as calling as the app `harbor-desk-portal`. `expected/callers.yaml` is every route's callers and
Harbor Desk's chains, written by hand:

`Harbor Desk (declared; app harbor-desk-portal) → edge-gateway forge-refunds-v1 (oauth2; scopes refunds.write; internal) → refunds-api POST /refunds → partner-gateway northwind-refunds-v1 (oauth2; scopes northwind.refunds.write; external) → northwind-pay-api POST /v2/refunds`

Files here are byte-exact: facts cite their line numbers.
