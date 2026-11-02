import type { Api } from "@maycombhq/core";
import type { Router, ServerContext } from "@maycombhq/server";
import { contractCheckOf } from "./contract-check-files.js";

/**
 * Map › Mismatches (plan item F7, ADR 0164): the contract check on every link, estate-wide, as
 * `atticus join contracts --json` gives it. Files only: no git, no network, nothing written.
 */
export async function contractsView(root: string): Promise<Api.ContractsViewT> {
  const { result, notes } = await contractCheckOf(root);
  return { links: result.links, findings: result.findings, counts: result.counts, notes };
}

export function uiContractsRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/contracts", async () => ({
    status: 200,
    body: await contractsView(ctx.root),
  }));
}
