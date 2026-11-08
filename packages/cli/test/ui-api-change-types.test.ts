import { expect, it } from "vitest";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { speckitRoot } from "./run-helpers.js";

/** API 2.64.0 (UX review): the New change form lists the org pack's change types. */
it("lists the change types", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const res = await fetch(`${s.url}/api/change-types`, {
      headers: { "X-Atticus-Token": s.token },
    });
    expect(res.status).toBe(200);
    const types = (await res.json()) as { id: string; name: string }[];
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t.id && t.name)).toBe(true);
  } finally {
    await s.close();
  }
}, 60_000);
