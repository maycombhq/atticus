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

Item 5 (ADR 0210 part 2) adds a recipe for the modules (`org-pack/reading-rules/types/integration-module.yaml`),
each module's entries written by hand (`facts/<repo>.jsonl`) for its proof, and the engine's output on the
ledger module (`expected/recipe-ledger.yaml`), checked by `packages/core/test/recipe.test.ts`.
