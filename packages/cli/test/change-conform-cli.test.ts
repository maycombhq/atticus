import { cp } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { CHANGE, FIXTURES, sh, speckitRoot, worktree } from "./run-helpers.js";
import { main } from "../src/main.js";
import { uiRoutes } from "../src/ui-api.js";
import { uiSpecRoutes } from "../src/ui-api-specs.js";

/**
 * atticus change conform (ADR 0114): the change branch's commit, scanned from the base clone,
 * checked against the transfer limit's target flows (fixtures/conform).
 */

const T = 300_000;
const CONFORM = join(FIXTURES, "conform");

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

let root: string;

beforeAll(async () => {
  ({ root } = await speckitRoot({ repos: ["forge-ledger"] }));
  const dir = join(root, "openspec/changes", CHANGE);
  await cp(join(CONFORM, "target-flows"), join(dir, "target-flows"), { recursive: true });
  await cp(join(CONFORM, "stories"), join(dir, "stories"), { recursive: true });
  await cp(join(CONFORM, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "forge/repos/forge-ledger"), join(root, "../repos/forge-ledger"), {
    recursive: true,
    force: true,
  });
  // A person builds part of the change on the change branch.
  const wt = worktree(root, "forge-ledger");
  await cp(join(CONFORM, "after/forge-ledger"), wt, { recursive: true });
  sh(wt, "add", "-A");
  sh(wt, "commit", "-q", "-m", "Part of the transfer limit");
}, T);

describe("atticus change conform", () => {
  it(
    "says what is missing, still there and not in the design, with the file and line, and exits 1",
    async () => {
      const r = await run(["change", "conform", CHANGE, "--root", root]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(
        /^forge-ledger at change\/add-transfer-limit \([0-9a-f]{12}, from [0-9a-f]{12}\): 4 found, 0 missing, 1 still there, 2 not in the design\.$/m,
      );
      // Eighth UX walk (rule 4): forge-ledger has no facts, so what its readers don't see is a
      // step a person checks, never MISSING.
      expect(r.out).not.toContain("MISSING");
      expect(r.out).toContain(
        "    ledger-api.create-transfer item 2 (call-out): forge-ledger hasn't been read into facts at this commit, and the built-in readers alone are only a cross-check, so Atticus couldn't confirm that ledger-api calls northwind-pay POST /v2/velocity-checks from the code; check it by hand",
      );
      expect(r.out).toContain(
        "  STILL THERE  ledger-api still calls northwind-pay POST /v2/payments, which item 4 of target-flows/ledger-api.create-transfer.yaml removes.  forge-ledger:src/main/java/forge/ledger/NorthwindClient.java:8",
      );
      expect(r.out).toContain(
        "  NOT IN THE DESIGN  The code adds the table ledger-db.limit-override, which no target flow names.  forge-ledger:src/main/resources/db/migration/V3__add_daily_limit.sql:3",
      );
      expect(r.out).toContain("ledger-api.create-transfer item 3 (branch):");
      expect(r.out).toContain("atticus findings add-transfer-limit lists them");
    },
    T,
  );

  it(
    "--latest --json shows the stored check without scanning; a missing change is exit 2",
    async () => {
      const r = await run(["change", "conform", CHANGE, "--latest", "--json", "--root", root]);
      expect(r.code).toBe(0);
      const v = Api.ChangeConformance.parse(JSON.parse(r.out));
      expect(v.flows).toBe(2);
      expect(v.results.map((x) => [x.repo, x.ref, x.counts])).toEqual([
        [
          "forge-ledger",
          "change/add-transfer-limit",
          { found: 4, missing: 0, stillThere: 1, unexpected: 2 },
        ],
      ]);
      expect((await run(["change", "conform", "no-such", "--root", root])).code).toBe(2);
      expect((await run(["change", "conform", "--root", root])).code).toBe(2);
    },
    T,
  );
});

describe("GET /api/changes/{id}/conformance (ADR 0114)", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ root, port: 0, extend: (r, ctx) => uiSpecRoutes(r, ctx) });
  });
  afterAll(async () => srv?.close());
  const get = async (path: string) => {
    const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
    return { status: r.status, body: (await r.json()) as unknown };
  };

  it(
    "answers the stored check with each finding's state, and a 404 for a change that isn't there",
    async () => {
      await run(["change", "conform", CHANGE, "--root", root]);
      const r = await get(`/api/changes/${CHANGE}/conformance`);
      expect(r.status).toBe(200);
      const v = Api.ChangeConformance.parse(r.body);
      expect(v.gate).toBe("conform");
      expect(v.round).toBeGreaterThan(0);
      expect(v.results[0]!.items.filter((i) => i.finding).map((i) => i.finding!.state)).toEqual([
        "open",
        "open",
        "open",
      ]);
      expect((await get("/api/changes/no-such/conformance")).status).toBe(404);
    },
    T,
  );
});

describe("POST /api/changes/{id}/conformance: Check the code again from the app (eighth UX walk)", () => {
  it(
    "runs the check as a local job on the person's click: 202, then the job's lines; 404 for no change",
    async () => {
      const s = await startServer({
        root,
        port: 0,
        user: "pat",
        extend: (r, ctx) => uiRoutes(r, ctx),
      });
      try {
        const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
        const r = await fetch(`${s.url}/api/changes/${CHANGE}/conformance`, {
          method: "POST",
          headers: h,
          body: "{}",
        });
        expect(r.status).toBe(202);
        const { jobId } = (await r.json()) as { jobId: string };
        let job: { state: string; kind?: string; result?: { code: number; lines: string[] } };
        for (;;) {
          job = (await (
            await fetch(`${s.url}/api/jobs/${jobId}`, { headers: h })
          ).json()) as typeof job;
          if (job.state !== "running" && job.state !== "queued") break;
          await new Promise((x) => setTimeout(x, 100));
        }
        // Findings are the check's answer, not a failed step: the job is done.
        expect(job.state).toBe("done");
        expect(job.result?.code).toBe(0);
        expect(job.result?.lines.join("\n")).toMatch(
          /^forge-ledger at change\/add-transfer-limit \([0-9a-f]{12}, from [0-9a-f]{12}\): 4 found, 0 missing, 1 still there, 2 not in the design\.$/m,
        );
        const none = await fetch(`${s.url}/api/changes/no-such/conformance`, {
          method: "POST",
          headers: h,
          body: "{}",
        });
        expect(none.status).toBe(404);
      } finally {
        await s.close();
      }
    },
    T,
  );
});
