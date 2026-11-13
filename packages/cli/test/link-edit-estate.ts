import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { parse } from "yaml";
import { parseRecord, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

/**
 * The estate the canvas's link edits are tested on (Delete this link, and beta.28's Edit the
 * map): the invented Northwind proxy estate of `fixtures/gateway-facts/policy-tokens/`, adopted
 * by `atticus upgrade --yes` from a beta.26 catalog with the path-guessed arrows, one of which
 * cites no line of its caller's (the arrow This link is wrong can't correct). Files only, no
 * network (CLAUDE.md rule 5).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
export const COMMIT: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
export const PROXY = "northwind_pay_1-0";
const AT = new Date("2026-11-12T10:00:00.000Z");
export type Iface = Extract<CatalogRecord, { kind: "Interface" }>;

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

export interface LinkEstate {
  root: string;
  srv: RunningServer;
  /** The lineless arrow's Interface: adopted, with no line of its caller's. */
  lineless: Iface;
  /** A lined arrow's Interface, derived from the facts. */
  lined: Iface;
  /** `atticus verify <repo> --write`, as a person runs it (a large removal confirmed). */
  verify(repo: string): Promise<void>;
  interfaces(): Promise<Iface[]>;
  call(
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
  job(path: string, body: unknown): Promise<Ended>;
  close(): Promise<void>;
}
export type Ended = {
  state: string;
  errors?: string[];
  result?: { code: number; lines: string[]; [k: string]: unknown };
};

export async function linkEstate(prefix: string): Promise<LinkEstate> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // Started once the estate is ready; the helpers read it when they are called.
  const at: { srv?: RunningServer } = {};
  const verify = async (repo: string) => {
    const out: string[] = [];
    const code = await verifyCommand(
      root,
      repo,
      { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
      { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
    );
    expect(code, out.join("\n")).toBe(0);
  };
  const interfaces = async () =>
    (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records.filter(
      (r): r is Iface => r.kind === "Interface",
    );
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(at.srv!.url + path, {
      method,
      headers: {
        "X-Atticus-Token": at.srv!.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
  };
  const job = async (path: string, body: unknown): Promise<Ended> => {
    const started = await call(path, "POST", body);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    for (let n = 0; n < 1200; n++) {
      const j = await call(`/api/jobs/${String(started.body.jobId)}`);
      if (j.body.state !== "running" && j.body.state !== "queued") return j.body as Ended;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${path} didn't end`);
  };

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
  const { main } = await import("../src/main.js");
  const said: string[] = [];
  const code = await main(["upgrade", "--yes", "--root", root], {
    out: (l) => said.push(l),
    err: (l) => said.push(l),
  });
  expect(code, said.join("\n")).toBe(0);
  const all = await interfaces();
  const lineless = all.find(
    (i) => i.from === "northwind-pay-proxy" && i.to === "refunds-api" && i.method === "GET",
  )!;
  expect(lineless).toBeDefined();
  expect(lineless.evidence.some((e) => e.side === "caller")).toBe(false);
  const lined = all.find(
    (i) => i.from === "northwind-pay-proxy" && i.to === "payments-api" && i.method === "POST",
  )!;
  expect(lined.evidence.some((e) => e.side === "caller")).toBe(true);
  keepCatalogsInMemory(true);
  const srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
  at.srv = srv;
  return {
    root,
    srv,
    lineless,
    lined,
    verify,
    interfaces,
    call,
    job,
    close: async () => {
      keepCatalogsInMemory(false);
      await srv.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
