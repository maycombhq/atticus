import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockNotifier } from "@maycombhq/adapters";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiAcrossRoutes } from "../src/ui-api-across.js";
import { uiMeRoutes } from "../src/ui-api-me.js";
import { digestCommand } from "../src/digest-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const CHANGE = "add-transfer-limit";

let root: string;
let srv: RunningServer;
const notifier = new MockNotifier();

async function writeRecord(dir: string, raw: Record<string, unknown>) {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...raw });
  if (!p.ok) throw new Error(JSON.stringify(p));
  const f = join(root, dir, recordPath(p.record));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, serializeRecord(p.record));
}

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-across-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  // What the catalog already maps on the audit hop (curated by a person).
  await writeRecord("catalog/curated", {
    kind: "FieldMapping",
    id: "fm-audit-subject",
    interface: "if-5c55930b735276a9",
    sourceField: "account.id",
    targetField: "subject",
    transform: "as is",
    confidence: "asserted",
    evidence: [{ source: "manual", by: "ari" }],
  });
  // The plan hand-off is open, raised by bao, with the delivery group asked to review.
  const file = join(root, "openspec/changes", CHANGE, "change.yaml");
  const c = parse(await readFile(file, "utf8")) as { handoffs: unknown[] };
  c.handoffs.push({
    phase: "plan",
    state: "open",
    approvals: [],
    artifacts: [],
    branch: `handoff/${CHANGE}/plan`,
    by: "bao",
    openedAt: "2026-10-20T09:00:00Z",
    pr: { number: 3, url: "https://git.example.com/forge/forge-metarepo/pull/3" },
    reviewers: ["forge/delivery", "tia"],
  });
  await writeFile(file, stringify(c));
  // Left from ADR 0044: groups and a view, which nothing reads any more.
  await mkdir(join(root, ".atticus"), { recursive: true });
  await writeFile(
    join(root, ".atticus/me.yaml"),
    "groups: [Forge Delivery]\nview: delivery-lead\n",
  );
  srv = await startServer({
    root,
    port: 0,
    user: "dana",
    extend: (r, ctx) =>
      uiAcrossRoutes(uiMeRoutes(r, ctx, { notify: notifier, now: "2026-10-20T10:00:00Z" }), ctx),
  });
});
afterAll(() => srv?.close());

describe("views across every open change", () => {
  it("lists tasks, stories, requests and releases with the change they belong to", async () => {
    const tasks = await call("GET", "/api/across?view=tasks");
    expect(tasks.status).toBe(200);
    expect(tasks.body).toMatchObject({ view: "tasks", changes: 1 });
    const rows = tasks.body.rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]).toMatchObject({ change: CHANGE, changeTitle: "Add a daily transfer limit" });
    expect(rows.every((r) => typeof r.repo === "string" && typeof r.done === "boolean")).toBe(true);

    const stories = (await call("GET", "/api/across?view=stories")).body.rows as Record<
      string,
      unknown
    >[];
    expect(stories.map((s) => s.id)).toContain("s4-velocity-check");
    expect(stories.find((s) => s.id === "s2-show-remaining")).toMatchObject({
      dependsOn: ["s1-refuse-over-limit"],
    });

    const requests = (await call("GET", "/api/across?view=requests")).body.rows as Record<
      string,
      unknown
    >[];
    expect(requests[0]).toMatchObject({ change: CHANGE, state: "to-file" });

    const releases = (await call("GET", "/api/across?view=releases")).body.rows as Record<
      string,
      unknown
    >[];
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      change: CHANGE,
      atRelease: false,
      handoff: { phase: "plan", state: "open" },
    });
  });

  it("findings and tests come back as lists even when nothing was reviewed yet", async () => {
    const f = await call("GET", "/api/across?view=findings");
    expect(f.status).toBe(200);
    expect(f.body.rows).toEqual([]);
    const t = (await call("GET", "/api/across?view=tests")).body.rows as Record<string, unknown>[];
    expect(t[0]).toMatchObject({ change: CHANGE });
    expect(typeof t[0]!.gaps).toBe("number");
  });

  it("refuses an unknown view and names the ones there are", async () => {
    const r = await call("GET", "/api/across?view=everything");
    expect(r.status).toBe(400);
    expect(String(r.body.detail)).toMatch(/findings, tasks, stories, tests, requests, releases/);
  });
});

describe("the field-mapping grid", () => {
  it("shows each hop's rows from mappings.md beside what the catalog maps today", async () => {
    const g = await call("GET", `/api/changes/${CHANGE}/mappings`);
    expect(g.status).toBe(200);
    const hops = g.body.hops as {
      heading: string;
      noChange: boolean;
      note?: string;
      rows: { source: string; target: string; rule: string; whenMissing: string }[];
      asIs: { id: string; source: string; target: string }[];
    }[];
    expect(hops.map((h) => h.heading)).toEqual([
      "POST /transfers",
      "GET /accounts/{id}/limit",
      "POST /v2/velocity-checks",
      "POST /audit/events",
    ]);
    expect(hops[0]).toMatchObject({ noChange: true, rows: [] });
    expect(hops[0]!.note).toMatch(/LIMIT_EXCEEDED/);
    expect(hops[1]!.rows[0]).toEqual(
      expect.objectContaining({
        source: "account.daily_limit",
        target: "limit",
        rule: "as is",
        whenMissing: "404 when the account is unknown",
      }),
    );
    expect(hops[3]!.asIs).toEqual([
      expect.objectContaining({ id: "fm-audit-subject", source: "account.id", target: "subject" }),
    ]);
    expect(g.body.catalogMappings).toBe(1);
  });

  it("is 404 for a change that doesn't exist", async () => {
    expect((await call("GET", "/api/changes/no-such/mappings")).status).toBe(404);
  });
});

describe("the digest (ADR 0048, 0073)", () => {
  it("lists no approvals waiting: reviews are the Git host's, and there are no groups", async () => {
    expect((await call("GET", "/api/me/approvals")).status).toBe(404);
    const d = await call("POST", "/api/me/digest", {});
    expect(d.body.title).toBe("Atticus: nothing waits on you");
    expect(d.body).not.toHaveProperty("waiting");
  });

  it("saves digest settings in the person's own file, dropping the old groups and view", async () => {
    const r = await call("PUT", "/api/me/notify", { digest: "daily", channel: "#dana-updates" });
    expect(r.status).toBe(200);
    expect(r.body.notify).toEqual({ digest: "daily", channel: "#dana-updates" });
    const saved = parse(await readFile(join(root, ".atticus/me.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved).toEqual({ notify: { digest: "daily", channel: "#dana-updates" } });
    expect((await call("PUT", "/api/me/notify", { digest: "hourly" })).status).toBe(400);
  });

  it("shows your hand-offs to revise, and sends the digest only when asked, with you as the approver", async () => {
    // Changes were requested on a hand-off dana raised.
    const file = join(root, "openspec/changes", CHANGE, "change.yaml");
    const was = await readFile(file, "utf8");
    const c = parse(was) as { handoffs: { phase: string; by: string; state: string }[] };
    const plan = c.handoffs.find((h) => h.phase === "plan")!;
    plan.by = "dana";
    plan.state = "changes-requested";
    await writeFile(file, stringify(c));
    const seen = await call("POST", "/api/me/digest", {});
    expect(seen.status).toBe(200);
    expect(seen.body.title).toBe("Atticus: 1 thing waits on you");
    expect(seen.body.revise).toEqual([
      expect.objectContaining({
        change: CHANGE,
        phase: "plan",
        pr: "https://git.example.com/forge/forge-metarepo/pull/3",
      }),
    ]);
    expect(seen.body.sent).toBeUndefined();
    expect(notifier.sent).toHaveLength(0);

    const sent = await call("POST", "/api/me/digest", { send: true });
    expect(sent.body.sent).toEqual({ id: "msg-1", channel: "#dana-updates" });
    expect(notifier.sent[0]).toMatchObject({ channel: "#dana-updates", mentions: ["dana"] });
    expect(notifier.sent[0]!.body).toMatch(/pull\/3/);
    expect(notifier.journal.at(-1)?.approval).toMatchObject({ by: "dana", ref: "digest:dana" });
    await writeFile(file, was);
  });

  it("says why it wasn't sent when no notify adapter is connected, or it is manual", async () => {
    const runtime = join(root, "org-pack/runtime.yaml");
    const was = await readFile(runtime, "utf8");
    await writeFile(runtime, was.replace(/^ {2}notify:.*$/m, ""));
    const out: string[] = [];
    const err: string[] = [];
    const code = await digestCommand(
      root,
      { as: "dana", send: true },
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    expect(out[0]).toMatch(/wait/);
    expect(err.join("\n")).toMatch(/No notify adapter/);
    await writeFile(runtime, was.replace(/^ {2}notify:.*$/m, "  notify: { type: manual }"));
    const err2: string[] = [];
    expect(
      await digestCommand(
        root,
        { as: "dana", send: true },
        { out: () => undefined, err: (l) => err2.push(l) },
      ),
    ).toBe(1);
    expect(err2.join("\n")).toMatch(/manual here/);
    await writeFile(runtime, was);
  });
});
