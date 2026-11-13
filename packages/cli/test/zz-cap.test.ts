import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { buildAndWrite } from "@maycombhq/scanner";
import { makeBigEstate } from "./big-estate.js";
it("caps", async () => {
  for (const o of [{ repos: 6 }, { repos: 12, clusters: 4 }] as const) {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cap-"));
    const { root } = await makeBigEstate(dir, { ...o, entries: 40, calls: 30, tables: 4, settings: 4, gateways: 2, routes: 10 } as never);
    const b = await buildAndWrite(root, { command: "atticus catalog build" });
    const caps = b.build.records.filter((r) => r.kind === "Capability") as { id: string; entryPoints: string[] }[];
    console.log("CAPS", JSON.stringify(o), caps.length, caps.map((c) => `${c.id}:${c.entryPoints.length}`).slice(0, 12).join(" "));
  }
}, 600000);
