import { loadavg } from "node:os";
import { join } from "node:path";
import { settleAfterResult } from "@maycombhq/core";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoId, writeBigRepo } from "./big-estate.js";

/**
 * ADR 0205's CPU budgets (big-estate-speed and field-estate-speed, with ATTICUS_BENCH=1): one
 * repo's write (`verify <repo> --write`'s catalog write) after a first write that fills the
 * caches, `runs` times, each after another change of the repo; the CPU seconds of each (this
 * process's, every thread's, the caches after the result included) and their median.
 */
export async function steadyWriteCpu(
  root: string,
  options: Parameters<typeof writeBigRepo>[2],
  label: string,
  runs = 3,
): Promise<{ median: number; each: number[] }> {
  const repo = bigRepoId(1);
  const quiet = { out: () => undefined, err: () => undefined };
  const each: number[] = [];
  for (let k = 0; k <= runs; k++) {
    const facts = await writeBigRepo(root, 1, options, 40 + k, true, false);
    const c = process.cpuUsage();
    const t = performance.now();
    const w = await writeFactsIntoCatalog(
      root,
      repo,
      facts,
      { dir: join(root, "workspace", repo), command: `atticus verify ${repo} --write` },
      quiet,
    );
    await settleAfterResult();
    const u = process.cpuUsage(c);
    const s = (u.user + u.system) / 1e6;
    if (!w) throw new Error(`${label}: the write of ${repo} wrote nothing`);
    console.log(
      `${label} write ${k}${k === 0 ? " (fills the caches, not counted)" : ""}: ${s.toFixed(1)} CPU s, ${((performance.now() - t) / 1000).toFixed(1)} s, load ${loadavg()
        .map((x) => x.toFixed(1))
        .join(" ")}`,
    );
    if (k > 0) each.push(s);
  }
  const median = [...each].sort((a, b) => a - b)[Math.floor(each.length / 2)]!;
  return { median, each };
}
