import { cp, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAndWrite } from "@maycombhq/scanner";
import { startServer, STOPPING, TOO_LATE, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyCommand } from "../src/verify-commands.js";
import { writeProgressHooks } from "../src/write-progress.js";
import { BIG_COMMIT, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

/**
 * Beta.28.4 (field report: an Apply over 40 repos ran five hours and could not be stopped): Stop
 * during an Apply over several repos. A repo's write is never cut short, as before; the run ends
 * before the next repo starts, saying which repos it applied and which it didn't, with the lock
 * freed and the job stopped (not failed). Asked while a repo is still being read or built, it
 * ends there with nothing of that repo in the catalog, as one repo's Apply does. One repo's own
 * Apply is exactly as it was: past its write's start, Stop is too late.
 *
 * A generated Forge estate of four repos, three of them changed since their last Apply; what the
 * stopped runs leave is compared, byte for byte, with the same repos applied one at a time by
 * `verify <repo> --write`. Invented names only (CLAUDE.md rule 3); no network (rule 5).
 */
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const made: string[] = [];
const servers: RunningServer[] = [];
const [R1, R2, R3] = [bigRepoId(0), bigRepoId(1), bigRepoId(2)];
/** The estate with the three repos' changes waiting, and what it is after 1, 2 and 3 applies. */
let waiting: string;
const after: Map<string, Buffer>[] = [];
/** What it is with only the second repo applied (the first has no clone, so it fails). */
let secondOnly: Map<string, Buffer>;
const HEARD = "Stop heard: the run ends when this repo's write has finished.";
const STOPPING_AFTER = "Stopping after this repo…";
/** A copy's first repo left with no clone: its Apply fails at once, saying so. */
const noCloneOfFirst = (root: string) =>
  rename(join(root, "workspace", R1), join(root, "workspace", `${R1}-moved`));

/** Every file a run leaves but this machine's state, the clones, and the questions (dated). */
async function filesOf(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (!e.isDirectory()) out.set(relative(dir, p).split(sep).join("/"), await readFile(p));
      else if (![".index", ".atticus", "workspace", "questions"].includes(e.name)) await walk(p);
    }
  };
  await walk(dir);
  return out;
}
const differences = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => !a.get(p) || !b.get(p) || !a.get(p)!.equals(b.get(p)!))
    .sort();

beforeAll(async () => {
  // Every step of a write is said, however quick, so a test can ask Stop at a known step.
  writeProgressHooks.quietMs = 0;
  const dir = await mkdtemp(join(tmpdir(), "atticus-apply-stop-"));
  made.push(dir);
  const { root, options } = await makeBigEstate(dir, {
    repos: 4,
    entries: 12,
    calls: 8,
    tables: 2,
    settings: 6,
    seed: 5,
    checkouts: 4,
  });
  const cold = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(cold.guard.refused).toBeUndefined();
  for (const r of [0, 1, 2]) await writeBigRepo(root, r, options, 4 + r, true, false);
  waiting = root;
  const one = await copy();
  const quiet = { out: () => undefined, err: () => undefined };
  for (const repo of [R1, R2, R3]) {
    expect(await verifyCommand(one, repo, { write: true }, quiet), repo).toBe(0);
    after.push(await filesOf(one));
  }
  const second = await copy();
  await noCloneOfFirst(second);
  expect(await verifyCommand(second, R2, { write: true }, quiet)).toBe(0);
  secondOnly = await filesOf(second);
}, 600_000);
afterAll(async () => {
  delete writeProgressHooks.quietMs;
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

/** A fresh copy of the estate with the three repos waiting. */
async function copy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-apply-stop-copy-"));
  made.push(dir);
  const root = join(dir, "forge");
  await cp(waiting, root, { recursive: true });
  return root;
}

type Ended = {
  state: string;
  progress: { done: number; total: number; message: string };
  result?: {
    code: number;
    lines: string[];
    applied?: string[];
    notApplied?: string[];
    stopped?: boolean;
    leftOut?: number;
    leftOutRepos?: number;
  };
};
/** Start `path` on a fresh copy, ask Stop when `when` says so of a printed line, and follow it. */
async function run(
  path: string,
  body: unknown,
  when?: (line: string, all: string[]) => boolean,
  prepare?: (root: string) => Promise<void>,
) {
  const root = await copy();
  await prepare?.(root);
  const s = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
  servers.push(s);
  const post = (p: string, b: unknown) =>
    fetch(s.url + p, {
      method: "POST",
      headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
  const printed: string[] = [];
  let asked = false;
  /** The job as the page sees it just after Stop, pressed three times. */
  let afterStop: { stopping?: boolean; message: string } | undefined;
  const off = s.jobs.subscribe((c) => {
    if (c.type !== "lines") return;
    for (const l of c.lines) {
      printed.push(l);
      if (!asked && when?.(l, printed)) {
        asked = true;
        for (let press = 0; press < 3; press++) expect(s.jobs.cancel(c.job.id)).toBe(true);
        const j = s.jobs.get(c.job.id)!;
        afterStop = { ...(j.stopping ? { stopping: true } : {}), message: j.progress.message };
      }
    }
  });
  const started = await post(path, body);
  expect(started.status).toBe(202);
  const { jobId } = (await started.json()) as { jobId: string };
  const ended = (await s.jobs.settle(jobId, 300_000)) as unknown as Ended;
  off();
  /** One repo's own Apply afterwards: the lock is free when it runs to its end. */
  const applyOne = async (repo: string) => {
    const r = await post(`/api/facts/${repo}/apply`, {});
    expect(r.status).toBe(202);
    return (await s.jobs.settle(
      ((await r.json()) as { jobId: string }).jobId,
      300_000,
    )) as unknown as Ended;
  };
  return { root, ended, printed, asked, afterStop, applyOne };
}
const ALL = { repos: [R1, R2, R3] };
/** True once the run is on its second repo. */
const onSecond = (all: string[]) => all.some((l) => l.startsWith(`Repo 2 of 3: ${R2}`));

describe("Stop during an Apply over several repos (beta.28.4), each repo its own build", () => {
  // v31: the per-repo loop is ATTICUS_APPLY_ONE_BUILD=0's (and a refused one build's) way; the
  // one build's Stop is below.
  beforeAll(() => {
    process.env.ATTICUS_APPLY_ONE_BUILD = "0";
  });
  afterAll(() => {
    delete process.env.ATTICUS_APPLY_ONE_BUILD;
  });
  it("not stopped: every repo applied, as before", async () => {
    const r = await run("/api/facts/apply-all", ALL);
    expect(r.ended.state, r.ended.result?.lines.join("\n")).toBe("done");
    expect(r.ended.result).toMatchObject({ code: 0, applied: [R1, R2, R3], notApplied: [] });
    expect(r.ended.result?.stopped).toBeUndefined();
    expect(differences(await filesOf(r.root), after[2]!)).toEqual([]);
    // The review: how it ended keeps the run's own count (it once ended as "1 of 1").
    expect(r.ended.progress).toEqual({ done: 3, total: 3, message: "Done" });
  }, 600_000);

  it("asked as the second repo starts: the first is applied, the second and third are not, and the catalog is the first repo's", async () => {
    const r = await run("/api/facts/apply-all", ALL, (l) => l.startsWith(`Repo 2 of 3: ${R2}`));
    expect(r.asked).toBe(true);
    // Stopped, never failed, with what it did and didn't do by name.
    expect(r.ended.state).toBe("cancelled");
    expect(r.ended.progress).toEqual({ done: 1, total: 3, message: "Stopped." });
    expect(r.ended.result).toMatchObject({ applied: [R1], notApplied: [R2, R3], stopped: true });
    expect(r.ended.result?.lines).toContain(
      `Stopped after 1 of 3 repos. Not applied: ${R2}, ${R3}.`,
    );
    expect(r.printed.some((l) => l.startsWith("Repo 3 of 3"))).toBe(false);
    // Nothing of the second repo is in the catalog, its specs or its map.
    const left = differences(await filesOf(r.root), after[0]!);
    expect(left.filter((p) => !p.startsWith("facts/"))).toEqual([]);
    // The lock is free: the second repo's own Apply runs, and leaves what two applies leave.
    const next = await r.applyOne(R2);
    expect(next.state, next.result?.lines.join("\n")).toBe("done");
    expect(differences(await filesOf(r.root), after[1]!)).toEqual([]);
  }, 600_000);

  it("asked while the second repo is being read and built: it ends there, nothing of it written", async () => {
    const r = await run(
      "/api/facts/apply-all",
      ALL,
      (l, all) => onSecond(all) && l.startsWith("Building the catalog: pass 2 of"),
    );
    expect(r.asked).toBe(true);
    expect(r.ended.state).toBe("cancelled");
    expect(r.ended.result).toMatchObject({ applied: [R1], notApplied: [R2, R3], stopped: true });
    const left = differences(await filesOf(r.root), after[0]!);
    expect(left.filter((p) => !p.startsWith("facts/"))).toEqual([]);
    expect((await r.applyOne(R2)).state).toBe("done");
  }, 600_000);

  it("asked while the second repo is being written: its write finishes whole, then the run ends before the third", async () => {
    const r = await run(
      "/api/facts/apply-all",
      ALL,
      (l, all) => onSecond(all) && l.startsWith("Writing contracts"),
    );
    expect(r.asked).toBe(true);
    // Said heard, once for three presses, in the run's own words (never "too late": the run
    // does stop), and the job says it is stopping from then on, so the page's Stop stays so.
    expect(r.printed.filter((l) => l === HEARD)).toHaveLength(1);
    expect(r.printed).not.toContain(TOO_LATE);
    expect(r.afterStop).toEqual({ stopping: true, message: STOPPING_AFTER });
    expect(r.printed.indexOf(STOPPING)).toBeGreaterThan(r.printed.indexOf(HEARD));
    expect(r.printed.some((l) => l.startsWith("Rendering the map"))).toBe(true);
    expect(r.printed.some((l) => l.startsWith("Repo 3 of 3"))).toBe(false);
    expect(r.ended.state).toBe("cancelled");
    expect(r.ended.result).toMatchObject({ applied: [R1, R2], notApplied: [R3], stopped: true });
    expect(r.ended.result?.lines).toContain(`Stopped after 2 of 3 repos. Not applied: ${R3}.`);
    expect(r.ended.progress).toEqual({ done: 2, total: 3, message: "Stopped." });
    // The second repo's write is whole: the catalog, specs, report and map two applies leave.
    expect(differences(await filesOf(r.root), after[1]!)).toEqual([]);
    const next = await r.applyOne(R3);
    expect(next.state, next.result?.lines.join("\n")).toBe("done");
    expect(differences(await filesOf(r.root), after[2]!)).toEqual([]);
  }, 600_000);

  // The review: a Stop that lands in the step's yield just before the write's commit (the last
  // point it could have been heard) is not lost, and cuts nothing short.
  it("asked in the moment before the second repo's write starts: its write still finishes whole, then the run ends", async () => {
    const r = await run(
      "/api/facts/apply-all",
      ALL,
      (l, all) => onSecond(all) && l.startsWith("Writing the catalog ("),
    );
    expect(r.asked).toBe(true);
    expect(r.printed.some((l) => l.startsWith("Repo 3 of 3"))).toBe(false);
    expect(r.ended.state).toBe("cancelled");
    // Stop was asked before the commit and not heard before it (no step came between): it is
    // taken as a Stop during the write, said heard, and the write is whole.
    expect(r.printed.filter((l) => l === HEARD)).toHaveLength(1);
    expect(r.printed).not.toContain(TOO_LATE);
    expect(r.ended.result).toMatchObject({ applied: [R1, R2], notApplied: [R3], stopped: true });
    expect(differences(await filesOf(r.root), after[1]!)).toEqual([]);
    expect((await r.applyOne(R3)).state).toBe("done");
  }, 600_000);

  // The review: a repo that failed earlier in the run stays "not applied" when the run is
  // stopped, and the count of repos gone through stays true.
  it("stopped after a repo that failed: the failed repo and the repos not reached are the ones not applied", async () => {
    const r = await run(
      "/api/facts/apply-all",
      ALL,
      (l, all) => onSecond(all) && l.startsWith("Writing contracts"),
      noCloneOfFirst,
    );
    expect(r.asked).toBe(true);
    expect(r.ended.state).toBe("cancelled");
    expect(r.ended.result).toMatchObject({ applied: [R2], notApplied: [R1, R3], stopped: true });
    expect(r.ended.result?.lines).toContain(
      `Stopped after 2 of 3 repos. Not applied: ${R1}, ${R3}.`,
    );
    const left = differences(await filesOf(r.root), secondOnly);
    expect(left.filter((p) => !p.startsWith("workspace/"))).toEqual([]);
  }, 600_000);

  it("asked while the last repo is being written: too late, and the run ends done with all applied", async () => {
    const r = await run(
      "/api/facts/apply-all",
      ALL,
      (l, all) => all.some((x) => x.startsWith("Repo 3 of 3")) && l.startsWith("Writing contracts"),
    );
    expect(r.asked).toBe(true);
    expect(r.printed).toContain(HEARD);
    expect(r.printed).not.toContain(STOPPING);
    expect(r.ended.state).toBe("done");
    expect(r.ended.progress.message).toBe("Done");
    expect(r.ended.result).toMatchObject({ code: 0, applied: [R1, R2, R3], notApplied: [] });
    expect(r.ended.result?.stopped).toBeUndefined();
    expect(differences(await filesOf(r.root), after[2]!)).toEqual([]);
  }, 600_000);
});

describe("Stop during an Apply over several repos with one build (v31)", () => {
  /** Every file but the repos' verify reports, whose links one build lists at each repo's ends. */
  const butReports = (d: string[]) => d.filter((p) => !p.endsWith(".verify.yaml"));
  it("not stopped: every repo applied in one build", async () => {
    const r = await run("/api/facts/apply-all", ALL);
    expect(r.ended.state, r.ended.result?.lines.join("\n")).toBe("done");
    expect(r.ended.result).toMatchObject({ code: 0, applied: [R1, R2, R3], notApplied: [] });
    expect(r.ended.result?.lines.join("\n")).toContain(
      "Wrote the catalog for 3 repos in one build",
    );
    expect(butReports(differences(await filesOf(r.root), after[2]!))).toEqual([]);
    expect(r.ended.progress).toEqual({ done: 3, total: 3, message: "Done" });
  }, 600_000);

  it("asked as the second repo is verified: nothing of any repo is written", async () => {
    const r = await run("/api/facts/apply-all", ALL, (l) => l.startsWith(`Repo 2 of 3: ${R2}`));
    expect(r.asked).toBe(true);
    expect(r.ended.state).toBe("cancelled");
    expect(r.ended.result).toMatchObject({ applied: [], notApplied: [R1, R2, R3], stopped: true });
    expect(r.ended.result?.lines).toContain(
      `Stopped before the catalog was written: none of the 3 repos was applied. Not applied: ${R1}, ${R2}, ${R3}.`,
    );
    const left = differences(await filesOf(r.root), await filesOf(waiting));
    expect(left.filter((p) => !p.startsWith("facts/"))).toEqual([]);
    // The lock is free: a repo's own Apply runs.
    expect((await r.applyOne(R1)).state).toBe("done");
  }, 600_000);

  it("asked while the one build is built: nothing of any repo is written", async () => {
    const r = await run(
      "/api/facts/apply-all",
      ALL,
      (l, all) =>
        all.some((x) => x.startsWith("Writing the catalog once for 3 repos")) &&
        l.startsWith("Building the catalog: pass 2 of"),
    );
    expect(r.asked).toBe(true);
    expect(r.ended.state).toBe("cancelled");
    expect(r.ended.result).toMatchObject({ applied: [], notApplied: [R1, R2, R3], stopped: true });
    const left = differences(await filesOf(r.root), await filesOf(waiting));
    expect(left.filter((p) => !p.startsWith("facts/"))).toEqual([]);
  }, 600_000);

  it("asked while the one build is written: too late, and the run ends done with all applied", async () => {
    const r = await run("/api/facts/apply-all", ALL, (l) => l.startsWith("Writing contracts"));
    expect(r.asked).toBe(true);
    expect(r.printed).not.toContain(STOPPING);
    expect(r.ended.state).toBe("done");
    expect(r.ended.result).toMatchObject({ code: 0, applied: [R1, R2, R3], notApplied: [] });
    expect(butReports(differences(await filesOf(r.root), after[2]!))).toEqual([]);
  }, 600_000);
});

describe("a run where one repo fails and another is applied with facts left out (beta.28.4)", () => {
  // The review: the count of facts left out was dropped from the result when another repo of
  // the run failed, so the page couldn't say it.
  it("keeps how many facts were left out, in how many repos, beside the repos by name", async () => {
    const bad = JSON.parse(
      (await readFile(join(VERIFY, "redteam.facts.jsonl"), "utf8")).split("\n")[0]!,
    ) as { id: string };
    const r = await run("/api/facts/apply-all", { repos: [R1, R2] }, undefined, async (root) => {
      await noCloneOfFirst(root);
      const facts = join(root, "facts", `${R2}.jsonl`);
      const two = [1, 2].map((n) =>
        JSON.stringify({ ...bad, id: `${bad.id}-${n}`, commit: BIG_COMMIT }),
      );
      await writeFile(facts, (await readFile(facts, "utf8")) + two.join("\n") + "\n");
    });
    expect(r.ended.state, r.ended.result?.lines.join("\n")).toBe("failed");
    expect(r.ended.result).toMatchObject({
      applied: [R2],
      notApplied: [R1],
      leftOut: 2,
      leftOutRepos: 1,
    });
    expect(r.ended.result?.stopped).toBeUndefined();
  }, 600_000);
});

describe("one repo's own Apply is as it was (beta.28.1's commit point)", () => {
  it("asked while it is being written: never cut short, and it ends done", async () => {
    const r = await run(`/api/facts/${R1}/apply`, {}, (l) => l.startsWith("Writing contracts"));
    expect(r.asked).toBe(true);
    expect(r.printed).toContain(TOO_LATE);
    expect(r.printed).not.toContain(STOPPING);
    expect(r.ended.state).toBe("done");
    expect(r.ended.result?.code).toBe(0);
    expect(r.ended.progress).toEqual({ done: 1, total: 1, message: "Done" });
    expect(differences(await filesOf(r.root), after[0]!)).toEqual([]);
  }, 600_000);

  it("asked while it is being built: it stops there with nothing written", async () => {
    const r = await run(`/api/facts/${R1}/apply`, {}, (l) =>
      l.startsWith("Building the catalog: pass 2 of"),
    );
    expect(r.asked).toBe(true);
    expect(r.ended.state).toBe("cancelled");
    const base = await filesOf(waiting);
    const left = differences(await filesOf(r.root), base);
    expect(left.filter((p) => !p.startsWith("facts/"))).toEqual([]);
  }, 600_000);
});
