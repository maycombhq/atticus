import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

const { main } = await import("../src/main.js");

/**
 * Beta.27.1 (the owner's decision of 2026-11-12: "an arrow for an architect must be as simple as
 * clicking delete"): Delete this link on any link of the canvas, lined or lineless, derived or
 * adopted from a catalog before the slots. The metarepo is the invented Northwind proxy estate
 * of `fixtures/gateway-facts/policy-tokens/`, adopted by `atticus upgrade --yes` from a beta.26
 * catalog with the path-guessed arrows, one of which cites no line of its caller's: the arrow
 * This link is wrong can't correct. Delete writes the person's curated suppress of each Interface
 * behind the link (the decision `atticus catalog edits --curate` writes for a deleted file) and
 * builds, as one local job whose lines are its Console entry; Bring back removes the decision and
 * builds again. Files only, no network (CLAUDE.md rule 5).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const COMMIT: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
const PROXY = "northwind_pay_1-0";
const AT = new Date("2026-11-12T10:00:00.000Z");
type Iface = Extract<CatalogRecord, { kind: "Interface" }>;

const lines = (text: string) => text.split("\n").filter((l) => l.trim());
const factsOf = (repo: string) => readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8");
/** The proxy's facts as beta.26 joined them by the path guess (policy-tokens-cli.test.ts). */
const pathGuessed = () =>
  lines(factsOf(PROXY))
    .filter((l) => !l.includes('"kind":"config"'))
    .map((l) => l.replace(`"host":"@targetVendorUrl@",`, ""))
    .map((l) =>
      l.replace(
        '{"file":"apiproxy/targets/TE-Vendor.xml","line":3,"value":"@targetVendorUrl@"}',
        '{"file":"apiproxy/proxies/default.xml","line":20,"value":"TE-Vendor"}',
      ),
    )
    .join("\n") + "\n";

let root: string;
let srv: RunningServer;
/** The lineless arrow's Interface: adopted, with no line of its caller's. */
let lineless: Iface;
/** A lined arrow's Interface, derived from the facts. */
let lined: Iface;

async function verify(repo: string): Promise<void> {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
}

const interfaces = async () =>
  (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records.filter(
    (r): r is Iface => r.kind === "Interface",
  );

async function call(path: string, method = "GET", body?: unknown) {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
}
type Ended = { state: string; result?: { code: number; lines: string[] } };
async function job(path: string, body: unknown): Promise<Ended> {
  const started = await call(path, "POST", body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  for (let n = 0; n < 1200; n++) {
    const j = await call(`/api/jobs/${String(started.body.jobId)}`);
    if (j.body.state !== "running" && j.body.state !== "queued") return j.body as Ended;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${path} didn't end`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-link-delete-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(join(root, "facts", `${r}.jsonl`), r === PROXY ? pathGuessed() : factsOf(r));
  }
  for (const r of Object.keys(COMMIT)) await verify(r);
  // A beta.26 metarepo: no slots, and one path-guessed arrow that lost its caller's line.
  rmSync(join(root, "catalog", "sources"), { recursive: true, force: true });
  rmSync(join(root, ".atticus"), { recursive: true, force: true });
  const dir = join(root, "catalog", "generated", "interface");
  for (const f of readdirSync(dir)) {
    const r = parse(readFileSync(join(dir, f), "utf8")) as Iface;
    if (r.from !== "northwind-pay-proxy" || r.method !== "GET" || r.to !== "refunds-api") continue;
    const only = { ...r, evidence: r.evidence.filter((e) => e.side !== "caller") };
    expect(parseRecord(only).ok).toBe(true);
    writeFileSync(join(dir, f), serializeRecord(only as CatalogRecord));
  }
  const said: string[] = [];
  const code = await main(["upgrade", "--yes", "--root", root], {
    out: (l) => said.push(l),
    err: (l) => said.push(l),
  });
  expect(code, said.join("\n")).toBe(0);
  const all = await interfaces();
  lineless = all.find(
    (i) => i.from === "northwind-pay-proxy" && i.to === "refunds-api" && i.method === "GET",
  )!;
  expect(lineless).toBeDefined();
  expect(lineless.evidence.some((e) => e.side === "caller")).toBe(false);
  lined = all.find(
    (i) => i.from === "northwind-pay-proxy" && i.to === "payments-api" && i.method === "POST",
  )!;
  expect(lined.evidence.some((e) => e.side === "caller")).toBe(true);
  keepCatalogsInMemory(true);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
}, 300_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
  await srv?.close();
  rmSync(root, { recursive: true, force: true });
});

const decisionFile = (id: string) =>
  join(root, "catalog", "curated", "curateddecision", `${id}.yaml`);

describe("Delete this link (beta.27.1)", () => {
  it("refuses an empty list, a record that isn't an Interface of the catalog, and a bad body", async () => {
    expect((await call("/api/links/delete", "POST", { interfaces: [] })).status).toBe(400);
    expect(
      (await call("/api/links/delete", "POST", { interfaces: ["if-nothing"], from: "a", to: "b" }))
        .status,
    ).toBe(404);
    expect((await call("/api/links/delete", "POST", { interfaces: "x" })).status).toBe(400);
    expect((await call("/api/links/deleted/undo", "POST", { decisions: ["cd-x"] })).status).toBe(
      404,
    );
    // Nothing deleted yet.
    expect((await call("/api/links/deleted")).body).toEqual({ links: [] });
  });

  it("takes away a lineless arrow adopted from a beta.26 catalog, as a curated suppress, and brings it back", async () => {
    // The arrow is one the upgrade adopted into the legacy joins slot, not one the facts derive.
    const legacy = join(root, "catalog", "sources", "legacy", "joins.json");
    expect(readFileSync(legacy, "utf8")).toContain(lineless.id);

    const ended = await job("/api/links/delete", {
      interfaces: [lineless.id],
      from: "northwind-pay-proxy",
      to: "refunds-api",
    });
    expect(ended.state, JSON.stringify(ended)).toBe("done");
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    // Its lines are the job's Console entry: the decision written, then the build's own.
    expect(ended.result?.lines.some((l) => l.includes("curateddecision"))).toBe(true);
    expect((await interfaces()).some((i) => i.id === lineless.id)).toBe(false);
    expect((await interfaces()).some((i) => i.id === lined.id)).toBe(true);

    // The decision is the one a deleted generated file becomes: a suppress of the Interface.
    const listed = await call("/api/links/deleted");
    expect(listed.status).toBe(200);
    expect(listed.body.links).toHaveLength(1);
    const link = listed.body.links[0];
    expect(link).toMatchObject({ from: "northwind-pay-proxy", to: "refunds-api", by: "pat" });
    expect(link.decisions).toHaveLength(1);
    const d = link.decisions[0];
    expect(d.target).toBe(lineless.id);
    const rec = parse(readFileSync(decisionFile(d.id), "utf8")) as Record<string, unknown>;
    expect(rec).toMatchObject({
      kind: "CuratedDecision",
      action: "suppress",
      target: lineless.id,
      value: null,
      status: "current",
      confidence: "asserted",
      by: "pat",
    });
    expect(d.file).toBe(`catalog/curated/curateddecision/${d.id}.yaml`);

    // Deleting it again: it isn't on the map any more.
    const again = await call("/api/links/delete", "POST", {
      interfaces: [lineless.id],
      from: "northwind-pay-proxy",
      to: "refunds-api",
    });
    expect(again.status).toBe(404);

    // Bring back: the decision goes, and the next build draws the arrow again.
    const back = await job("/api/links/deleted/undo", { decisions: [d.id] });
    expect(back.state, JSON.stringify(back)).toBe("done");
    expect(back.result?.code, back.result?.lines.join("\n")).toBe(0);
    expect(existsSync(decisionFile(d.id))).toBe(false);
    expect((await interfaces()).some((i) => i.id === lineless.id)).toBe(true);
    expect((await call("/api/links/deleted")).body).toEqual({ links: [] });
  }, 240_000);

  it("takes away a lined arrow the facts derive, every call of the link in one job", async () => {
    const both = (await interfaces()).filter(
      (i) => i.from === "northwind-pay-proxy" && i.to === "payments-api",
    );
    expect(both.length).toBeGreaterThan(1);
    const ended = await job("/api/links/delete", {
      interfaces: both.map((i) => i.id),
      from: "northwind-pay-proxy",
      to: "payments-api",
    });
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    const now = await interfaces();
    for (const i of both) expect(now.some((x) => x.id === i.id)).toBe(false);
    const listed = (await call("/api/links/deleted")).body.links;
    expect(listed).toHaveLength(1);
    expect(listed[0].decisions.map((x: { target: string }) => x.target).sort()).toEqual(
      both.map((i) => i.id).sort(),
    );
    const back = await job("/api/links/deleted/undo", {
      decisions: listed[0].decisions.map((x: { id: string }) => x.id),
    });
    expect(back.result?.code, back.result?.lines.join("\n")).toBe(0);
    const after = await interfaces();
    for (const i of both) expect(after.some((x) => x.id === i.id)).toBe(true);
  }, 240_000);
});
