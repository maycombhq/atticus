import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { estateFacts, estateJoinOf } from "@maycombhq/scanner";
import { TOO_LATE } from "@maycombhq/server";
import { estateJoinOnFile, stampOf } from "../src/contract-check-files.js";
import { uiFactsRoutes } from "../src/ui-api-facts.js";
import { linksJobHooks, pairingsOf, uiLinkRoutes } from "../src/ui-api-links.js";

/**
 * Beta.28.1 (the owner's field reports 2 and 3, local API 3.14.0, additive): the Connect panel's
 * read of the calls and APIs (GET /api/links/candidates, a whole-estate join the first open after
 * a write works out again) and the pairing preview (POST /api/links/connect with preview) ran for
 * minutes inside one request, with nothing in the Console and no Stop. Asked as a job (`job=1`,
 * `job: true`), each answers 202 and the job's id at once; the job prints each step (its last
 * line is its progress message, for the panel's spinner), Stop ends it between steps, and its
 * result's `answer` is the answer the request gives without `job` (or `problem`, refused). On
 * the invented Forge estate of fixtures/prototype-compare, as ui-api-links.test.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");

let srv: RunningServer;
let root: string;

const LOOSE = JSON.stringify({
  kind: "call",
  id: "call.post.capture-charge",
  repo: "forge-billing",
  commit: "aaa1111",
  callType: "rest",
  method: "POST",
  path: "captureChargePath",
  cite: {
    file: "src/main/java/forge/billing/PartnerClient.java",
    line: 31,
    value: "captureChargePath",
  },
  verified: "line",
  by: "assistant",
  conf: "declared",
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-links-jobs-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(root, d), { recursive: true });
  await appendFile(join(root, "facts/forge-billing.jsonl"), `${LOOSE}\n`);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) =>
      uiFactsRoutes(uiLinkRoutes(r, ctx, { now: () => new Date("2026-11-06T12:00:00.000Z") }), ctx),
  });
});
afterAll(() => srv?.close());
afterEach(() => {
  delete linksJobHooks.onStep;
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const CANDS = "/api/links/candidates?from=forge-billing&to=forge-partner-gateway";
const PAIR = {
  from: "forge-billing",
  to: { repo: "forge-partner-gateway" },
  pairs: [
    {
      call: "call.post.capture-charge",
      api: "entry.post.partners-northwind-charges-chargeid-capture",
    },
  ],
};

const started = (r: { status: number; body: Record<string, unknown> }) => {
  expect(r.status).toBe(202);
  return Api.JobAccepted.parse(r.body).jobId;
};
const linesOf = (id: string) => srv.jobs.linesOf(id)?.lines ?? [];

describe("Connect's reads as jobs (beta.28.1, API 3.14.0)", () => {
  it("reads the candidates as a job: 202 at once, the steps as lines, the same answer", async () => {
    const plain = Api.LinkCandidatesView.parse((await call("GET", CANDS)).body);
    const id = started(await call("GET", `${CANDS}&job=1`));
    const j = await srv.jobs.settle(id);
    expect(j.state).toBe("done");
    expect(j.title).toBe("Reading the calls and APIs: forge-billing → forge-partner-gateway");
    const result = j.result as { answer: unknown; lines: string[] };
    expect(Api.LinkCandidatesView.parse(result.answer)).toEqual(plain);
    const lines = linesOf(id);
    const steps = lines.filter((l) => l.endsWith(" in)")).map((l) => l.replace(/… \(.*$/, ""));
    expect(steps).toEqual([
      "Reading the estate's facts",
      "Joining the estate's calls and APIs",
      "Reading forge-partner-gateway's APIs",
      "Matching forge-billing's calls with them",
    ]);
    // The join was worked out by the plain read just before, kept by its stamp: said so.
    expect(lines).toContain("The estate's join is up to date: kept from the last read.");
  });

  it("works the join out again after a write, saying how many repos it joins", async () => {
    await writeFile(join(root, "facts/zz-touched.txt"), "a file the stamp reads\n");
    const id = started(await call("GET", `${CANDS}&job=1`));
    await srv.jobs.settle(id);
    expect(linesOf(id).some((l) => /^Joining the calls and APIs of \d+ repos/.test(l))).toBe(true);
  });

  it("a refusal is the job's problem, never a 500", async () => {
    const id = started(await call("GET", "/api/links/candidates?from=nope&to=forge-billing&job=1"));
    const j = await srv.jobs.settle(id);
    expect((j.result as { problem: { status: number } }).problem.status).toBe(404);
    // Two boxes not named is refused at once, as without a job.
    expect((await call("GET", "/api/links/candidates?from=forge-billing&job=1")).status).toBe(400);
  });

  it("Stop ends the read between steps: cancelled, no answer", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atJoin = new Promise<void>((r) => (reached = r));
    linksJobHooks.onStep = async (what) => {
      if (what.startsWith("Joining")) {
        reached();
        await held;
      }
    };
    const id = started(await call("GET", `${CANDS}&job=1`));
    await atJoin;
    expect((await call("POST", `/api/jobs/${id}/cancel`)).status).toBe(200);
    release();
    const j = await srv.jobs.settle(id);
    expect(j.state).toBe("cancelled");
    expect((j.result as { answer?: unknown } | undefined)?.answer).toBeUndefined();
    expect(linesOf(id).some((l) => l.startsWith("Reading forge-partner-gateway's APIs"))).toBe(
      false,
    );
  });

  it("previews a pairing as a job: the same answer, nothing written, its steps as lines", async () => {
    const plain = Api.ConnectLinksResult.parse(
      (await call("POST", "/api/links/connect", { ...PAIR, preview: true })).body,
    );
    const id = started(
      await call("POST", "/api/links/connect", { ...PAIR, preview: true, job: true }),
    );
    const j = await srv.jobs.settle(id);
    expect(j.state).toBe("done");
    expect(j.title).toBe("Working out what changes: forge-billing → forge-partner-gateway");
    const answer = Api.ConnectLinksResult.parse((j.result as { answer: unknown }).answer);
    expect(answer).toEqual(plain);
    expect(answer.written).toBe(false);
    await expect(
      readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8"),
    ).rejects.toThrow();
    const lines = linesOf(id);
    expect(lines.some((l) => l.startsWith("Reading the estate's facts"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Previewing the next Apply of forge-billing"))).toBe(
      true,
    );
    // The job's progress message is its last line said: the panel shows it under the spinner.
    expect(j.progress.message).not.toBe("");
  });

  it("Stop ends a preview between steps", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    linksJobHooks.onStep = async (what) => {
      if (what.startsWith("Previewing")) {
        reached();
        await held;
      }
    };
    const id = started(
      await call("POST", "/api/links/connect", { ...PAIR, preview: true, job: true }),
    );
    await at;
    await call("POST", `/api/jobs/${id}/cancel`);
    release();
    expect((await srv.jobs.settle(id)).state).toBe("cancelled");
  });

  it("a pairing reads A's calls and B's APIs, and the estate's join only to tell a redundant pair", async () => {
    const steps: string[] = [];
    const said: string[] = [];
    const p = await pairingsOf(root, PAIR, {
      by: "pat",
      at: "2026-11-06T12:00:00.000Z",
      steps: {
        step: async (w) => void steps.push(w),
        say: (l) => void said.push(l),
        tick: async () => undefined,
        commit: () => undefined,
      },
    });
    expect(p.corrections).toHaveLength(1);
    // Beta.28.1 integration: the join tells a pair the call has already (409/skip); it is kept on
    // file per stamp and shared while under way, so several pairings work it out once.
    expect(steps).toEqual([
      "Reading the estate's facts",
      "Joining the estate's calls and APIs",
      "Reading forge-partner-gateway's APIs",
    ]);
  });

  it("the preview after a correction as a job: the same answer, its steps as lines", async () => {
    const path = "/api/facts/forge-billing/preview?fact=call.post.capture-charge";
    const plain = (await call("GET", path)).body;
    const id = started(await call("GET", `${path}&job=1`));
    const j = await srv.jobs.settle(id);
    expect(j.state).toBe("done");
    expect(j.title).toBe("Previewing the next Apply of forge-billing");
    expect((j.result as { answer: unknown }).answer).toEqual(plain);
    expect(linesOf(id).length).toBeGreaterThan(0);
    // No facts: the job's problem is the 404 the read gives.
    const none = started(await call("GET", "/api/facts/forge-nothing/preview?job=1"));
    expect(
      ((await srv.jobs.settle(none)).result as { problem: { status: number } }).problem.status,
    ).toBe(404);
  });

  it("a pairing hears Stop up to its write's step; nothing is written then", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    linksJobHooks.onStep = async (what) => {
      if (what.startsWith("Reading forge-partner-gateway's APIs")) {
        reached();
        await held;
      }
    };
    const id = started(await call("POST", "/api/links/connect", { ...PAIR, job: true }));
    await at;
    await call("POST", `/api/jobs/${id}/cancel`);
    release();
    expect((await srv.jobs.settle(id)).state).toBe("cancelled");
    await expect(
      readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8"),
    ).rejects.toThrow();
  });

  it("past the pairing's write step a Stop is too late: the job ends done, the pairing written", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    // Held at the write's step, the Stop comes as the step ends (after its check): the commit
    // that follows says it is too late.
    linksJobHooks.onStep = async (what) => {
      if (what.startsWith("Writing the pairing")) {
        reached();
        await held;
      }
    };
    const id = started(await call("POST", "/api/links/connect", { ...PAIR, job: true }));
    await at;
    await call("POST", `/api/jobs/${id}/cancel`);
    release();
    const j = await srv.jobs.settle(id);
    // The hold was inside the step after its check: Stop is heard at the commit, too late.
    expect(j.state).toBe("done");
    expect(linesOf(id)).toContain(TOO_LATE);
    const text = await readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8");
    expect(text).toContain("call.post.capture-charge");
    await rm(join(root, "facts/forge-billing.corrections.jsonl"));
  });

  it("two reads of the same estate share one join under way", async () => {
    await writeFile(join(root, "facts/zz-touched-2.txt"), "a file the stamp reads again\n");
    const op = await loadOrgPack(orgPackDirOf(root));
    const estate = await estateFacts(root, op, "");
    const stamp = await stampOf(root);
    const [a, b] = await Promise.all([
      estateJoinOnFile(root, op, estate, stamp),
      estateJoinOnFile(root, op, estate, stamp),
    ]);
    expect(a).toBe(b);
    expect(a).toEqual(
      estateJoinOf(op, estate.repos, estate.targets, estate.pairs, estate.aiTargets),
    );
  });
});
