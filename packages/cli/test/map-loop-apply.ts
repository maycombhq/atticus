import { join } from "node:path";
import { hashCacheHooks } from "@maycombhq/core";
import { buildPhases } from "@maycombhq/scanner";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoId, type writeBigRepo } from "./big-estate.js";
import type { FieldEstate } from "./field-estate.js";

const quiet = { out: () => undefined, err: () => undefined };

/**
 * One repo of a generated estate applied with these facts (what `verify <repo> --write` runs
 * once the facts are verified), at a fixed clock: what it wrote, the record files its check of
 * the catalog on file opened, whether its build ran the passes, and the CPU time it took.
 */
export async function applyCounted(
  e: FieldEstate,
  r: number,
  facts: Awaited<ReturnType<typeof writeBigRepo>>,
) {
  const repo = bigRepoId(r);
  let opened = 0;
  let built = false;
  hashCacheHooks.onHashed = (n) => (opened += n);
  buildPhases.on = (p) => {
    if (p === "build: files and build.json") built = true;
  };
  const c = process.cpuUsage();
  try {
    const w = await writeFactsIntoCatalog(
      e.root,
      repo,
      facts,
      {
        dir: join(e.root, "workspace", repo),
        command: `atticus verify ${repo} --write`,
        now: new Date("2026-11-17T09:00:00Z"),
      },
      quiet,
    );
    const used = process.cpuUsage(c);
    return { w, opened, built, cpu: (used.user + used.system) / 1e6 };
  } finally {
    delete hashCacheHooks.onHashed;
    buildPhases.on = undefined;
  }
}
