import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Api,
  interfaceId,
  parseFacts,
  parseRecord,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { forgetCatalogs, keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { drawnOf } from "../src/ui-api-links.js";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

/**
 * ADR 0199, the review (S1): a call paired with an API that lives in a module of the other repo.
 * The catalog draws its arrow to the module's component, which is drawn inside the repo's box:
 * the pairing is on the map, and the panel must not say it waits for an Apply for ever. On the
 * invented token-host estate (`fixtures/gateway-facts/token-host/`), with the service's code
 * listed as a module of its repo. Files only.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const PROXY = "forge_instruments_1-0";
const SERVICE = "forge-instruments";
const MODULE = "instruments-core";
const COMMIT: Record<string, string> = { [PROXY]: "8a1c0de", [SERVICE]: "5e1f00d" };
const MEANT: Record<string, string> = {
  "call.get.instruments-ping": "entry.get.instruments-ping",
  "call.post.instruments": "entry.post.instruments",
};
type Iface = Extract<CatalogRecord, { kind: "Interface" }>;

let root: string;
let srv: RunningServer;
const verify = async (repo: string) => {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    {
      commit: COMMIT[repo]!,
      dir: join(root, "workspace", repo),
      write: true,
      now: () => new Date("2026-11-16T10:00:00.000Z"),
    },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
};
const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-links-modules-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  // The service's code is a module of its repo, with a component of its own.
  const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      "    owner: team-instruments\n",
      `    owner: team-instruments\n    modules:\n      - path: src\n        component: ${MODULE}\n`,
    ),
  );
  expect(readFileSync(manifest, "utf8")).toContain(`component: ${MODULE}`);
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    const facts = readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8");
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      // Each of the service's entries is the module's, as a read of a repo with modules says.
      r === SERVICE
        ? facts.replace(/"kind":"entry",/g, `"kind":"entry","component":"${MODULE}",`)
        : facts,
    );
  }
  for (const r of Object.keys(COMMIT)) await verify(r);
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
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a call paired with an API in a module of the other repo (ADR 0199, S1)", () => {
  it("is drawn once applied: the arrow to the module's component is an arrow to the repo's box", async () => {
    const pairs = Object.entries(MEANT).map(([c, a]) => ({ call: c, api: a }));
    const w = await call("/api/links/connect", "POST", {
      from: PROXY,
      to: { repo: SERVICE },
      pairs,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    await verify(PROXY);
    const drawn = (
      await readCatalog(join(root, "catalog", "generated"), { fresh: true })
    ).records.filter((r): r is Iface => r.kind === "Interface" && r.from === "instruments-proxy");
    // The premise: the catalog's arrows go to the module's component, not the repo's id.
    expect(drawn.map((i) => i.to)).toEqual([MODULE, MODULE]);
    const r = await call(`/api/links/candidates?from=${PROXY}&to=${SERVICE}`);
    const v = Api.LinkCandidatesView.parse(r.body);
    const mine = v.calls.filter((c) => c.fact in MEANT);
    expect(mine.map((c) => [c.status, c.drawn])).toEqual(Array(2).fill(["paired", true]));
    expect(v.applyPending).toBeUndefined();
    // Who paired them is said with each (S6).
    expect(mine.map((c) => [c.pairedBy, c.pairedAi])).toEqual(Array(2).fill(["pat", undefined]));
  });

  it("keeps every box a line's arrows go to, when two calls are cited on one line (S5)", async () => {
    const one = (
      await readCatalog(join(root, "catalog", "generated"), { fresh: true })
    ).records.find((r): r is Iface => r.kind === "Interface" && r.from === "instruments-proxy")!;
    // A second call on the same line, with an arrow of its own to another box, read first: the
    // line's "first" arrow is no longer the pairing's.
    const rec = one as unknown as { method?: string; normalizedPath: string };
    const other = {
      ...one,
      id: interfaceId(one.from, "forge-ledger", rec.method, rec.normalizedPath),
      to: "forge-ledger",
    };
    expect(parseRecord(other).ok, JSON.stringify(parseRecord(other))).toBe(true);
    const dir = join(root, "catalog", "curated", "interface");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${other.id}.yaml`), serializeRecord(other as CatalogRecord));
    forgetCatalogs();
    const parsed = parseFacts(readFileSync(join(root, "facts", `${PROXY}.jsonl`), "utf8"));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const facts = parsed.facts;
    const d = (await drawnOf(root, PROXY, facts))!;
    const cited = one.evidence!.find((e) => e.repo === PROXY && e.side !== "callee")!;
    const fact = facts.find(
      (f) => f.kind === "call" && f.cite.file === cited.path && f.cite.line === cited.line,
    )!;
    expect([...d.boxes(fact.id)].sort()).toEqual(["forge-ledger", MODULE].sort());
    expect(d.exact({ interface: one.id })).toBe(true);
    // The pairing is still told as drawn: by its own Interface, and by its box among the line's.
    const v = Api.LinkCandidatesView.parse(
      (await call(`/api/links/candidates?from=${PROXY}&to=${SERVICE}`)).body,
    );
    expect(v.calls.filter((c) => c.fact in MEANT).map((c) => c.drawn)).toEqual([true, true]);
  });
});
