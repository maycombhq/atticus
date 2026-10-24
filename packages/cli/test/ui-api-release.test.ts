import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { uiRoutes } from "../src/ui-api.js";
import { uiRunRoutes } from "../src/ui-api-run.js";

/**
 * The generated release views over the local API (ADR 0043, 0045) and the terminal: the
 * deployment plan, forecast, evidence pack, release notes, security review draft and outcomes
 * of the seeded change add-transfer-limit, in a copy of the Forge fixtures.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE = join(HERE, "../../../fixtures/forge-change/openspec/changes/add-transfer-limit");
const ID = "add-transfer-limit";
const NOW = "2026-10-21T09:00:00Z";
const T = 120_000;

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-release-"));
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
  await cp(CHANGE, join(root, "openspec/changes", ID), { recursive: true });
  return root;
}

/** Move the change on to released, keeping change.yaml's history valid. */
async function release(root: string) {
  const file = join(root, "openspec/changes", ID, "change.yaml");
  const c = parse(await readFile(file, "utf8")) as {
    state: string;
    history: Record<string, string>[];
  };
  for (const to of ["build", "qa", "release-ready", "released"]) {
    c.history.push({ from: c.state, to, at: "2026-10-20T15:00:00Z", by: "dana" });
    c.state = to;
  }
  await writeFile(file, stringify(c));
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

let root: string;
let srv: RunningServer;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as any };
}
const post = (path: string, body: unknown = {}) => call(path, { method: "POST", body });

beforeAll(async () => {
  root = await forgeRoot();
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => {
      const deps = { now: NOW };
      uiRunRoutes(uiRoutes(r, ctx, deps), ctx, deps);
    },
  });
}, T);
afterAll(() => srv?.close());

describe("release views over the API", () => {
  it(
    "returns the deployment plan with the forecast, and 404 for an unknown change",
    async () => {
      const p = await call(`/api/release/${ID}/plan`);
      expect(p.status).toBe(200);
      expect(
        p.body.steps.map((s: { repo: string; kind: string }) => `${s.repo}:${s.kind}`),
      ).toEqual([
        "forge-ledger:migration",
        "forge-gateway:gateway-route",
        "forge-ledger:code",
        "forge-portal-bff:code",
        "forge-portal-ui:code",
      ]);
      expect(p.body.forecast).toMatchObject({ ready: "2026-10-28", status: "no-target" });
      expect(p.body.unplaced.map((u: { id: string }) => u.id)).toEqual([
        "audit-svc",
        "risk-engine",
      ]);
      const nope = await call("/api/release/nope/plan");
      expect(nope.status).toBe(404);
      expect(nope.body.detail).toBe("There is no change nope.");
    },
    T,
  );

  it(
    "returns the forecast on its own",
    async () => {
      const f = await call(`/api/release/${ID}/forecast`);
      expect(f.status).toBe(200);
      expect(f.body).toMatchObject({ ready: "2026-10-28", basis: "requests", waitDays: 5 });
    },
    T,
  );

  it(
    "returns the evidence pack as one Markdown document and a file list",
    async () => {
      const e = await call(`/api/release/${ID}/evidence`);
      expect(e.status).toBe(200);
      expect(e.body.markdown).toMatch(/^# Evidence pack: add-transfer-limit\n/);
      expect(e.body.markdown).toContain("## Approvals (hand-off PRs)");
      expect(e.body.files.map((f: { path: string }) => f.path)).toContain("brief.md");
      expect(e.body.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(
        true,
      );
    },
    T,
  );

  it(
    "returns release notes per audience, and 400 for an unknown audience in the command's words",
    async () => {
      const b = await call(`/api/release/${ID}/notes`);
      expect(b.status).toBe(200);
      expect(b.body.audience).toBe("business");
      expect(b.body.markdown).not.toContain("## API changes");
      const t = await call(`/api/release/${ID}/notes?audience=technical`);
      expect(t.body.markdown).toContain("## API changes");
      const bad = await call(`/api/release/${ID}/notes?audience=board`);
      expect(bad.status).toBe(400);
      expect(bad.body.detail).toMatch(/--audience business\|technical/);
    },
    T,
  );

  it(
    "returns the security review draft with who signs off and how",
    async () => {
      const s = await call(`/api/release/${ID}/security`);
      expect(s.status).toBe(200);
      // ADR 0073: the sign-off is approving and merging the hand-off PRs; no role is named.
      expect(s.body.signOff).not.toHaveProperty("role");
      expect(String((s.body.signOff as { how: string }).how)).toMatch(/merging a PR/);
      expect(s.body.markdown).toContain("## Data crossing a boundary");
    },
    T,
  );

  it(
    "refuses an outcome before release (422) and records one after, as the signed-in person",
    async () => {
      const early = await post(`/api/release/${ID}/outcomes`, { measure: "1", value: "0" });
      expect(early.status).toBe(422);
      expect(early.body.detail).toBe(
        "Outcomes are measured after release; add-transfer-limit is plan.",
      );
      expect((await post(`/api/release/${ID}/outcomes`, { measure: "1" })).status).toBe(400);
      expect((await post("/api/release/nope/outcomes", { measure: "1", value: "0" })).status).toBe(
        404,
      );
      await release(root);
      const ok = await post(`/api/release/${ID}/outcomes`, {
        measure: "1",
        value: "No transfer over a limit accepted in October",
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        measure: { id: "no-transfer-over-a-limit-is-accepted" },
        value: { by: "pat", at: NOW },
        written: "review/outcomes.yaml",
      });
      const list = await call(`/api/outcomes?change=${ID}`);
      expect(list.status).toBe(200);
      expect(list.body.measures[0].latest).toMatchObject({ by: "pat" });
      const all = await call("/api/outcomes");
      expect(all.body.map((v: { change: string }) => v.change)).toEqual([ID]);
    },
    T,
  );
});

describe("atticus release and outcome in the terminal", () => {
  it("lists the commands in the help", async () => {
    const c = capture();
    await main(["--help"], c.io);
    const help = c.out.join("\n");
    for (const cmd of [
      "atticus release plan <change>",
      "atticus release forecast <change>",
      "atticus release evidence <change>",
      "atticus release notes <change>",
      "atticus release security <change>",
      "atticus outcome list",
      "atticus outcome record <change> <measure>",
    ])
      expect(help, cmd).toContain(cmd);
  });

  it(
    "prints the plan in words, with its gaps",
    async () => {
      const r = await forgeRoot();
      const c = capture();
      expect(await main(["release", "plan", ID, "--root", r], c.io)).toBe(0);
      const text = c.out.join("\n");
      expect(text).toContain("1. forge-ledger (migration)");
      expect(text).toContain("rollback: GAP: No rollback step judged for");
      expect(text).toMatch(/audit-svc \(callee of POST \/audit\/events\) has no repo/);
    },
    T,
  );

  it(
    "writes the evidence pack to a folder",
    async () => {
      const r = await forgeRoot();
      const c = capture();
      const out = join(r, "evidence-out");
      expect(await main(["release", "evidence", ID, "--out", out, "--root", r], c.io)).toBe(0);
      expect(c.out[0]).toMatch(/^Wrote the evidence pack for add-transfer-limit to /);
      expect(await readFile(join(out, "evidence.md"), "utf8")).toMatch(/^# Evidence pack/);
    },
    T,
  );

  it(
    "records an outcome with --value and --by, and refuses without them",
    async () => {
      const r = await forgeRoot();
      await release(r);
      const bad = capture();
      expect(await main(["outcome", "record", ID, "1", "--root", r], bad.io)).toBe(2);
      const c = capture();
      expect(
        await main(
          ["outcome", "record", ID, "2", "--value", "0 reversals", "--by", "sam", "--root", r],
          c.io,
        ),
      ).toBe(0);
      expect(c.out[0]).toMatch(
        /^Recorded "0 reversals" for support-reversals-for-drained-accounts-drop-to-zero as sam\./,
      );
      const l = capture();
      expect(await main(["outcome", "list", "--change", ID, "--root", r], l.io)).toBe(0);
      expect(l.out.join("\n")).toContain("2. Support reversals for drained accounts drop to zero");
      const missing = capture();
      expect(await main(["release", "notes", "nope", "--root", r], missing.io)).toBe(1);
      expect(missing.err).toEqual(["There is no change nope."]);
    },
    T,
  );
});
