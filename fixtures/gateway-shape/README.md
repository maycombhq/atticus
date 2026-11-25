# The gateway shape: a proxy in front of two integration modules (item 0 of docs/plan/ai-first.md)

Invented Forge repos, no code from anywhere else. The shape is the one a path-matching join
can't draw:

| Repo                   | What it is                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge-edge-wallets`   | A gateway proxy bundle. Its flows are matched on a path suffix; its targets name a server, never a host; one flow's path is rewritten by a script. |
| `forge-edge-config`    | The gateway's environment config: each target server's host.                                                                                       |
| `forge-wallets-module` | An integration module: REST routes in a Blueprint Camel context, under `/cxf/api`. Its deploy files name its host.                                 |
| `forge-ledger-module`  | A second module on the same context path, serving `/accounts/{accountId}` too: a decoy for a match by path alone.                                  |

`reference.yaml` holds the true arrows, written by hand: four requests reach a module and one
reaches none (its target server, `legacy-core`, has no host anywhere in the estate).
`packages/cli/test/gateway-shape-fixture.test.ts` checks every line the reference cites.
