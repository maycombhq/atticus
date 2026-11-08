import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { CHANGE, speckitRoot } from "./run-helpers.js";

/** Third UX walk: a change's proposal not written yet opens empty, and Save writes it. */
it("opens a missing one-file artifact empty and creates it on save", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  await rm(join(root, "openspec/changes", CHANGE, "proposal.md"), { force: true });
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    const url = `${s.url}/api/changes/${CHANGE}/artifacts/proposal`;
    const got = (await (await fetch(url, { headers: h })).json()) as {
      content: string;
      sha256: string;
    };
    expect(got.content).toBe("");
    const put = await fetch(url, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "# Why\n\nTo cap transfers.\n", baseSha256: got.sha256 }),
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const again = (await (await fetch(url, { headers: h })).json()) as { content: string };
    expect(again.content).toContain("To cap transfers.");
  } finally {
    await s.close();
  }
}, 60_000);
