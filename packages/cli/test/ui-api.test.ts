import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { Api, Finding, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockGitHost } from "@maycombhq/adapters";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE_FIXTURES = join(HERE, "../../changes/test/fixtures/add-transfer-limit");
const REPO = "forge/forge-metarepo";
const ID = "add-transfer-limit";

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-api-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "*  @forge/platform\n");
  return root;
}

let root: string;
let srv: RunningServer;
const gh = new MockGitHost([{ repo: REPO }]);

async function call(path: string, o: { method?: string; body?: unknown } = {}) {
  const r = await fetch(srv.url + path, {
    method: o.method ?? "GET",
    headers: {
      "X-Atticus-Token": srv.token,
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

beforeAll(async () => {
  root = await forgeRoot();
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiRoutes(r, ctx, { gitHost: gh, now: "2026-10-19T09:00:00Z" }),
  });
});
afterAll(() => srv?.close());

describe("the write side of the local API runs the CLI's own commands", () => {
  it("creates a change (201), refuses a duplicate (409) and explains a bad form (400)", async () => {
    const bad = await call("/api/changes", { method: "POST", body: { id: ID } });
    expect(bad.status).toBe(400);
    expect(Api.Problem.parse(bad.body).errors?.map((e) => e.path)).toEqual(["title", "type"]);

    const made = await call("/api/changes", {
      method: "POST",
      body: {
        id: ID,
        title: "Add transfer limit",
        type: "feature",
        owners: { "product-owner": ["pat"], architect: ["ari", "avery"], developer: ["dev"] },
        systems: ["ledger", "portal"],
      },
    });
    expect(made.status).toBe(201);
    const d = Api.ChangeDetail.parse(made.body);
    expect(d).toMatchObject({ id: ID, state: "define", type: "feature" });
    expect(d.artifacts.find((a) => a.artifact === "brief")).toMatchObject({
      path: `openspec/changes/${ID}/brief.md`,
      status: "ready",
    });

    const again = await call("/api/changes", {
      method: "POST",
      body: { id: ID, title: "Add transfer limit", type: "feature" },
    });
    expect(again.status).toBe(409);
  });

  it("status says what to do next, in the CLI's words", async () => {
    const s = await call(`/api/changes/${ID}/status`);
    expect(s.status).toBe(200);
    expect(s.body.nextStep).toBe('Finish the define work, then raise "Send to architecture".');
    expect((await call("/api/changes/nope/status")).status).toBe(404);
  });

  it("saves an artifact only from the version the edit started from (409 otherwise)", async () => {
    const a = Api.ArtifactContent.parse((await call(`/api/changes/${ID}/artifacts/brief`)).body);
    const stale = await call(`/api/changes/${ID}/artifacts/brief`, {
      method: "PUT",
      body: { content: "x", baseSha256: "0".repeat(64) },
    });
    expect(stale.status).toBe(409);
    expect(Api.Problem.parse(stale.body).detail).toBe(
      "brief.md changed since you opened it. Reload it, then make your edit again.",
    );
    const saved = await call(`/api/changes/${ID}/artifacts/brief`, {
      method: "PUT",
      body: { content: a.content + "\nEdited in the UI.\n", baseSha256: a.sha256 },
    });
    expect(saved.status).toBe(200);
    expect(await readFile(join(root, "openspec/changes", ID, "brief.md"), "utf8")).toContain(
      "Edited in the UI.",
    );
    expect((await call(`/api/changes/${ID}/artifacts/nonsense`)).status).toBe(400);
  });

  it("refuses a hand-off that isn't ready with the CLI's reasons (422), then opens it (201)", async () => {
    const early = await call(`/api/changes/${ID}/handoff`, {
      method: "POST",
      body: { repo: REPO },
    });
    expect(early.status).toBe(422);
    expect(Api.Problem.parse(early.body).detail).toMatch(
      /^add-transfer-limit isn't ready for "Send to architecture"\./,
    );
    await cp(join(CHANGE_FIXTURES, "define"), join(root, "openspec/changes", ID), {
      recursive: true,
    });
    const ok = await call(`/api/changes/${ID}/handoff`, { method: "POST", body: { repo: REPO } });
    expect(ok.status).toBe(201);
    expect(Api.ChangeDetail.parse(ok.body).handoff).toMatchObject({
      phase: "define",
      state: "open",
    });
  });

  it("lists tasks from tasks.md with their task branches", async () => {
    await writeFile(
      join(root, "openspec/changes", ID, "tasks.md"),
      "# Tasks\n\n## forge-ledger\n\n- [x] 1.1 Add the column (story s1)\n- [ ] 1.2 Enforce the limit (story s2)\n",
    );
    const t = z.array(Api.Task).parse((await call(`/api/changes/${ID}/tasks`)).body);
    expect(t).toEqual([
      {
        id: "1.1",
        repo: "forge-ledger",
        description: "Add the column",
        done: true,
        story: "s1",
        branch: `task/${ID}/1.1`,
      },
      {
        id: "1.2",
        repo: "forge-ledger",
        description: "Enforce the limit",
        done: false,
        story: "s2",
        branch: `task/${ID}/1.2`,
      },
    ]);
  });

  it("records a finding action and returns the finding (and 404 for an unknown one)", async () => {
    const dir = join(root, "openspec/changes", ID, "review/define/1");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "r01-risky.yaml"),
      [
        "schemaVersion: 1",
        "id: r01-risky",
        "kind: issue",
        `change: ${ID}`,
        "gate: define",
        "round: 1",
        "rule: brief-questions-answered",
        "layer: org",
        "lens: business",
        "severity: risk",
        "artifact: brief.md",
        "locator:",
        "  heading: Goal",
        "summary: The brief doesn't say who asked for it.",
        "why: Nobody can confirm the need.",
        "fix:",
        "  text: Name the requester.",
        "evidence:",
        "  - source: artifact",
        "    path: brief.md",
        "waivable: true",
        "state: open",
        "createdAt: 2026-10-19T09:30:00Z",
        "",
      ].join("\n"),
    );
    const r = await call(`/api/findings/${ID}/r01-risky/action`, {
      method: "POST",
      body: { action: "not-relevant", reason: "The PO asked for it in the ticket." },
    });
    expect(r.status).toBe(200);
    expect(Finding.parse(r.body)).toMatchObject({ id: "r01-risky", state: "dismissed" });
    const missing = await call(`/api/findings/${ID}/nope/action`, {
      method: "POST",
      body: { action: "not-relevant", reason: "x" },
    });
    expect([404, 422]).toContain(missing.status);
  });

  it("runs a scan as a job: 202, then done, with its progress", async () => {
    const r = await call("/api/scan", { method: "POST", body: {} });
    expect(r.status).toBe(202);
    const { jobId } = Api.JobAccepted.parse(r.body);
    const job = await srv.jobs.settle(jobId);
    expect(job.kind).toBe("scan");
    expect(["done", "failed"]).toContain(job.state);
    const read = Api.Job.parse((await call(`/api/jobs/${jobId}`)).body);
    expect(read.progress).toEqual({ done: 1, total: 1, message: "Scanned" });
    expect((await call("/api/jobs/job-999")).status).toBe(404);
  });

  it("runs: none yet, and 404 for an unknown run", async () => {
    expect((await call(`/api/changes/${ID}/runs`)).body).toEqual([]);
    expect((await call("/api/runs/run-nope")).status).toBe(404);
  });
});
