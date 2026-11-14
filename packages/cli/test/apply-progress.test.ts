import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CancelledError, parseRecord, withSignal } from "@maycombhq/core";
import { BUILD_PASSES, buildCacheHooks, readCatalog } from "@maycombhq/scanner";
import { JobManager, TOO_LATE, type Job } from "@maycombhq/server";
import { capturedIo, main } from "../src/main.js";
import { verifyCommand } from "../src/verify-commands.js";
import { writeProgressHooks } from "../src/write-progress.js";
import { seedReadersSlots, verifyConfirmed } from "./seed-slots.js";

/**
 * Beta.28.1 (the owner's field report 1): Apply (`atticus verify <repo> --write`) printed the
 * verify report, then nothing while it loaded the catalog, built it and wrote contracts and
 * specs. Now each step is a progress line as it starts (`Output.progress`, the app's Console;
 * a terminal's standard error without it), the build pass by pass, and Stop is heard between
 * steps until the catalog is being written. On the invented Forge metarepo of the verify
 * fixtures (forge-ledger), its catalog first written once, as a person's first Apply.
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const T = 120_000;

async function metarepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atticus-apply-progress-"));
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await seedReadersSlots(root, raw);
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  // The first Apply, confirmed as a person confirms the readers' records it replaces.
  const quiet = { out: () => undefined, err: () => undefined };
  expect(await verifyConfirmed(root, "forge-ledger", opts(root), quiet)).toBe(0);
  return root;
}

const opts = (root: string) => ({
  commit: "0123abc",
  dir: join(root, "workspace", "forge-ledger"),
  write: true,
});

const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  const progress: string[] = [];
  return {
    out,
    err,
    progress,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      progress: (l: string) => progress.push(l),
    },
  };
};

const catalogText = async (root: string) =>
  JSON.stringify((await readCatalog(join(root, "catalog", "generated"))).records);

beforeEach(() => {
  writeProgressHooks.quietMs = 0;
  // Each pass runs (a build of the same inputs is otherwise the last one, kept whole).
  buildCacheHooks.off = true;
});
afterEach(() => {
  delete writeProgressHooks.quietMs;
  buildCacheHooks.off = false;
});

const stepsOf = (lines: readonly string[]) =>
  lines.filter((l) => l.endsWith(" in)")).map((l) => l.replace(/… \(.* in\)$/, ""));

describe("Apply's write stage says each step (beta.28.1)", () => {
  it(
    "says the steps in order, the build pass by pass, on the progress line only",
    async () => {
      const root = await metarepo();
      const s = sink();
      expect(await verifyCommand(root, "forge-ledger", opts(root), s.io)).toBe(0);
      const steps = stepsOf(s.progress);
      const passes = BUILD_PASSES.map(
        (what, i) => `Building the catalog: pass ${i + 1} of ${BUILD_PASSES.length} (${what})`,
      );
      expect(steps).toEqual([
        "Loading the catalog",
        "Reading the repo's contract files",
        "Reading the questions and the estate's facts",
        "Reading the build's inputs",
        ...passes,
        "Comparing the build with the catalog on file",
        "Reading the catalog's files to check the build",
        "Checking the build's guards",
        expect.stringMatching(/^Writing the catalog \(\d+ record files\)$/),
        "Writing contracts",
        "Writing specs",
        "Writing the flows",
        "Asking about the calls nothing joins",
        "Rendering the map",
      ]);
      expect(s.progress).toContain(
        `The catalog on file: ${(await readCatalog(join(root, "catalog", "generated"))).records.length} records.`,
      );
      expect(s.progress.at(-1)).toMatch(/^The write took \d+ s\.$/);
      // The result's lines stay the result's: no progress line in them.
      expect([...s.out, ...s.err].some((l) => /… \(.* in\)$/.test(l))).toBe(false);
      expect(s.out.join("\n")).toMatch(/Wrote the catalog for forge-ledger/);
    },
    T,
  );

  it(
    "goes to standard error (err) where no progress line is given: a terminal, the run log",
    async () => {
      const root = await metarepo();
      const out: string[] = [];
      const err: string[] = [];
      const code = await verifyCommand(root, "forge-ledger", opts(root), {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      expect(code).toBe(0);
      expect(stepsOf(err)).toContain("Writing specs");
      expect(stepsOf(out)).toEqual([]);
    },
    T,
  );

  it(
    "stops between the build's passes on Stop, writing nothing, and frees the lock",
    async () => {
      const root = await metarepo();
      const before = await catalogText(root);
      const ctl = new AbortController();
      const s = sink();
      const io = {
        ...s.io,
        progress: (l: string) => {
          s.progress.push(l);
          if (l.startsWith("Building the catalog: pass 3 ")) ctl.abort();
        },
      };
      await expect(
        withSignal(ctl.signal, () => verifyCommand(root, "forge-ledger", opts(root), io)),
      ).rejects.toBeInstanceOf(CancelledError);
      expect(stepsOf(s.progress).at(-1)).toMatch(/pass 3 of/);
      expect(stepsOf(s.progress)).not.toContain("Checking the build's guards");
      expect(await catalogText(root)).toBe(before);
      // The scan's lock is free: the next Apply runs.
      const again = sink();
      expect(await verifyCommand(root, "forge-ledger", opts(root), again.io)).toBe(0);
    },
    T,
  );

  it(
    "hears Stop no more once the catalog is being written: says why, and finishes the write",
    async () => {
      const root = await metarepo();
      const ctl = new AbortController();
      const s = sink();
      const io = {
        ...s.io,
        progress: (l: string) => {
          s.progress.push(l);
          if (l.startsWith("Writing the catalog (")) ctl.abort();
        },
      };
      expect(
        await withSignal(ctl.signal, () => verifyCommand(root, "forge-ledger", opts(root), io)),
      ).toBe(0);
      expect(s.progress.filter((l) => l.startsWith("Stop heard"))).toHaveLength(1);
      expect(stepsOf(s.progress)).toContain("Writing specs");
      expect(stepsOf(s.progress)).toContain("Rendering the map");
    },
    T,
  );
});

/** A verify --write run as the app runs it: a job, its progress on the job's lines. */
async function asJob(
  root: string,
  stopAt: (line: string) => boolean,
): Promise<{ job: Job; lines: string[]; out: string[]; err: string[] }> {
  const jobs = new JobManager(() => undefined);
  const out: string[] = [];
  const err: string[] = [];
  let id = "";
  const job = jobs.start("work", async () => {
    const io = capturedIo(out, err);
    const code = await main(
      [
        "verify",
        "forge-ledger",
        "--write",
        "--commit",
        "0123abc",
        "--dir",
        opts(root).dir,
        "--root",
        root,
      ],
      {
        ...io,
        progress: (l) => {
          io.progress!(l);
          if (stopAt(l)) jobs.cancel(id);
        },
      },
      { quiet: true },
    );
    return { result: { code } };
  });
  id = job.id;
  const done = await jobs.settle(job.id, T);
  return { job: done, lines: jobs.linesOf(job.id)?.lines ?? [], out, err };
}

describe("Apply as a job (the review of beta.28.1)", () => {
  it(
    "a Stop once the catalog is being written is too late: the job ends done and says so",
    async () => {
      const root = await metarepo();
      const r = await asJob(root, (l) => l.startsWith("Writing the catalog ("));
      expect(r.job.state).toBe("done");
      expect((r.job.result as { code: number }).code).toBe(0);
      expect(r.lines).toContain(TOO_LATE);
      expect(r.lines.some((l) => l.startsWith("Rendering the map"))).toBe(true);
      expect(r.lines.some((l) => l.startsWith("Stop heard"))).toBe(false);
    },
    T,
  );

  it(
    "a Stop after the commit is too late too: the write goes on to its end",
    async () => {
      const root = await metarepo();
      const r = await asJob(root, (l) => l.startsWith("Writing contracts"));
      expect(r.job.state).toBe("done");
      expect(r.lines).toContain(TOO_LATE);
      expect(r.lines.some((l) => l.startsWith("Writing specs"))).toBe(true);
    },
    T,
  );

  it(
    "progress goes to the job's lines, never into what the command answers (out, err)",
    async () => {
      const root = await metarepo();
      const r = await asJob(root, () => false);
      expect(r.job.state).toBe("done");
      expect(stepsOf(r.lines)).toContain("Writing specs");
      expect([...r.out, ...r.err].some((l) => /… \(.* in\)$/.test(l))).toBe(false);
      expect(r.err.some((l) => l.startsWith("The write took"))).toBe(false);
    },
    T,
  );

  it(
    "a Stop before the commit ends the job stopped, with no end line",
    async () => {
      const root = await metarepo();
      const r = await asJob(root, (l) => l.startsWith("Building the catalog: pass 3 "));
      expect(r.job.state).toBe("cancelled");
      expect(r.lines.some((l) => l.startsWith("The write took"))).toBe(false);
    },
    T,
  );
});

describe("atticus catalog build says each step (field hunt G2)", () => {
  it(
    "says the build pass by pass, the check, the guards and the write, on the progress line only",
    async () => {
      const root = await metarepo();
      const { catalogBuild } = await import("../src/catalog-build-commands.js");
      const s = sink();
      expect(await catalogBuild(root, {}, s.io)).toBe(0);
      const passes = BUILD_PASSES.map(
        (what, i) => `Building the catalog: pass ${i + 1} of ${BUILD_PASSES.length} (${what})`,
      );
      expect(stepsOf(s.progress)).toEqual([
        "Reading the build's inputs",
        ...passes,
        "Reading the catalog's files to check the build",
        "Checking the build's guards",
        expect.stringMatching(/^Writing the catalog \(\d+ record files\)$/),
      ]);
      expect(s.progress.at(-1)).toMatch(/^The build took \d+ s\.$/);
      expect([...s.out, ...s.err].some((l) => /… \(.* in\)$/.test(l))).toBe(false);
      // --check says its steps too, and writes nothing.
      const c = sink();
      expect(await catalogBuild(root, { check: true }, c.io)).toBe(0);
      expect(stepsOf(c.progress)).toEqual([
        "Reading the build's inputs",
        ...passes,
        "Reading the catalog's files to check the build",
        "Checking the build's guards",
      ]);
    },
    T,
  );

  it(
    "stops between the build's steps when Stop is asked, writing nothing",
    async () => {
      const root = await metarepo();
      const { catalogBuild } = await import("../src/catalog-build-commands.js");
      const before = await catalogText(root);
      const ctl = new AbortController();
      const s = sink();
      const io = {
        ...s.io,
        progress: (l: string) => {
          s.progress.push(l);
          if (l.startsWith("Building the catalog: pass 2 ")) ctl.abort();
        },
      };
      await expect(withSignal(ctl.signal, () => catalogBuild(root, {}, io))).rejects.toBeInstanceOf(
        CancelledError,
      );
      expect(await catalogText(root)).toBe(before);
    },
    T,
  );
});
