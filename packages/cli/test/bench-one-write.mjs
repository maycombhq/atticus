// ADR 0205: one repo's write in a process of its own, for big-estate-bench.test.ts's
// ATTICUS_BENCH_ONE (not part of `pnpm check`; it runs the built code, so build first).
// `node test/bench-one-write.mjs <root> <repo>` writes the repo's facts file as
// `verify <repo> --write` does after its check (writeFactsIntoCatalog); with `--verify` it runs
// verifyCommand with `write`, as the app's Apply does. It prints one line, `PHASES {…}`: the wall
// and CPU seconds, the peak memory, the load average and each phase of the build's clock.
import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { pathToFileURL } from "node:url";

const at = (p) => pathToFileURL(join(import.meta.dirname, "..", "..", p)).href;
const { buildPhases } = await import(at("scanner/dist/index.js"));
const core = await import(at("core/dist/index.js"));
const { writeFactsHooks } = await import(at("cli/dist/map-render-commands.js"));
// ADR 0205: ATTICUS_STEPS_OFF=1, the way before its steps (the whole comparison, every facts
// file parsed); `--verify` writes the caches after the result, timed apart (`settled`).
const off = !!process.env.ATTICUS_STEPS_OFF;
if (off) {
  writeFactsHooks.fullDiff = true;
  core.factsParseHooks.off = true;
}
const args = process.argv.slice(2);
const verify = args.includes("--verify");
const [root, repo] = args.filter((a) => a !== "--verify");
const quiet = { out: () => undefined, err: () => undefined, progress: () => undefined };
const phases = [];
buildPhases.on = (p, ms, cpu) => phases.push([p, ms, cpu]);
let rss = 0;
let heap = 0;
const sample = setInterval(() => {
  const m = process.memoryUsage();
  rss = Math.max(rss, m.rss);
  heap = Math.max(heap, m.heapUsed);
}, 100);
const t = performance.now();
const c = process.cpuUsage();
let written;
if (verify) {
  const { verifyCommand } = await import(at("cli/dist/verify-commands.js"));
  written = {
    code: await verifyCommand(
      root,
      repo,
      // The estate's checkouts have no .git: the facts' commit (big-estate.ts's BIG_COMMIT).
      { write: true, verbose: false, json: false, commit: "1111aaa", cachesAfterResult: !off },
      quiet,
    ),
  };
} else {
  const { writeFactsIntoCatalog } = await import(at("cli/dist/map-render-commands.js"));
  const facts = (await readFile(join(root, "facts", `${repo}.jsonl`), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const w = await writeFactsIntoCatalog(
    root,
    repo,
    facts,
    { dir: join(root, "workspace", repo), command: `atticus verify ${repo} --write` },
    quiet,
  );
  written = w?.written;
}
const done = (performance.now() - t) / 1000;
await core.settleAfterResult();
clearInterval(sample);
const u = process.cpuUsage(c);
const out = {
  wall: done,
  settled: (performance.now() - t) / 1000,
  cpu: (u.user + u.system) / 1e6,
  rss: rss / 1e9,
  heap: heap / 1e9,
  maxRSS: process.resourceUsage().maxRSS / 1e6,
  load: loadavg(),
  written,
  phases: {},
};
for (const [p, ms, cpu] of phases) {
  const was = out.phases[p] ?? [0, 0];
  out.phases[p] = [was[0] + ms / 1000, was[1] + cpu / 1000];
}
console.log(`PHASES ${JSON.stringify(out)}`);
