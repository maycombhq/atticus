import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { Api, type CatalogRecord } from "@maycombhq/core";
import { keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyConfirmed } from "./seed-slots.js";

/**
 * The estate "it's connected to the wrong box" is tested on (`fixtures/reconnect/`, invented):
 * forge-orders (A) makes seven calls, each joined to forge-billing (C) a different way, and each
 * really goes to forge-ledger (B), which serves the same seven APIs. Files only, no network.
 */

export const FIX = join(__dirname, "..", "..", "..", "fixtures", "reconnect");
export const A = "forge-orders";
export const B = "forge-ledger";
export const C = "forge-billing";
export const GATEWAY = "forge_billing_1-0";
export const VENDOR = "northwind-pay";
export const COMMIT: Record<string, string> = {
  [A]: "a11ce01",
  [C]: "b111ab1",
  [B]: "1ed9e42",
  [GATEWAY]: "9a7e0a1",
};
/** A's call for each way it was joined to the wrong box, and B's API it really is. */
export const CALLS = {
  /** (a) joined by its address: the host is forge-billing's. */
  host: { call: "call.get.holds-id", api: "entry.get.holds-id" },
  /** (b) the assistant's fact names forge-billing (`to`). */
  fact: { call: "call.post.holds-id-release", api: "entry.post.holds-id-release" },
  /** (c) a question about its host, answered forge-billing. */
  answer: { call: "call.get.fees-id", api: "entry.get.fees-id" },
  /** (d) paired with forge-billing by somebody else. */
  theirs: { call: "call.get.entries-id", api: "entry.get.entries-id" },
  /** (e) paired with forge-billing by the person themselves. */
  mine: { call: "call.post.entries", api: "entry.post.entries" },
  /** (f) through the gateway's route, which forwards to forge-billing. */
  gateway: { call: "call.get.billing-v1-statements-id", api: "entry.get.statements-id" },
  /** (g) to an outside system, Northwind Pay. */
  outside: { call: "call.post.charges", api: "entry.post.charges" },
} as const;
export const AT = new Date("2026-11-18T10:00:00.000Z");
export type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely

export interface ReconnectEstate {
  root: string;
  srv: RunningServer;
  verify(repo: string): Promise<string[]>;
  interfaces(): Promise<Iface[]>;
  /** The boxes A's arrows go to, each with how many: `{ "forge-billing": 5 }`. */
  arrows(): Promise<Record<string, number>>;
  call(path: string, method?: string, body?: unknown): Promise<{ status: number; body: Json }>;
  candidates(to: { repo?: string; system?: string }): Promise<Api.LinkCandidatesViewT>;
  close(): Promise<void>;
}

/** A person's pairing of one of A's calls with an entry of C, as Connect to… wrote it. */
export function pairingLine(call: string, entry: string, by: string): string {
  const f = readFileSync(join(FIX, "facts", `${A}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Json)
    .find((x) => x.id === call)!;
  const e = readFileSync(join(FIX, "facts", `${C}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Json)
    .find((x) => x.id === entry)!;
  return JSON.stringify({
    schemaVersion: 1,
    fact: f.id,
    target: { kind: "call", file: f.cite.file, line: f.cite.line, value: f.cite.value },
    action: "link",
    link: { repo: C, entry: e.id, method: e.method, path: e.path },
    by,
    at: "2026-11-10T09:00:00.000Z",
  });
}

export async function reconnectEstate(
  prefix: string,
  o: { user?: string } = {},
): Promise<ReconnectEstate> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const at: { srv?: RunningServer } = {};
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  // (d) and (e): two calls paired with the wrong box, one by sam and one by pat.
  writeFileSync(
    join(root, "facts", `${A}.corrections.jsonl`),
    [
      pairingLine(CALLS.theirs.call, CALLS.theirs.api, "sam"),
      pairingLine(CALLS.mine.call, CALLS.mine.api, o.user ?? "pat"),
    ].join("\n") + "\n",
  );
  const verify = async (repo: string) => {
    const out: string[] = [];
    const code = await verifyConfirmed(
      root,
      repo,
      { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
      { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
    );
    expect(code, out.join("\n")).toBe(0);
    return out;
  };
  const interfaces = async () =>
    (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records.filter(
      (r): r is Iface => r.kind === "Interface",
    );
  const arrows = async () => {
    const out: Record<string, number> = {};
    for (const i of await interfaces())
      if (i.from === A && i.status === "current") out[i.to] = (out[i.to] ?? 0) + 1;
    return out;
  };
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
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Json };
  };
  for (const r of [C, B, GATEWAY, A]) await verify(r);
  keepCatalogsInMemory(true);
  const srv = await startServer({
    root,
    port: 0,
    user: o.user ?? "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
  at.srv = srv;
  return {
    root,
    srv,
    verify,
    interfaces,
    arrows,
    call,
    candidates: async (to) => {
      const r = await call(
        `/api/links/candidates?from=${A}&${to.repo ? `to=${to.repo}` : `system=${to.system!}`}`,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return Api.LinkCandidatesView.parse(r.body);
    },
    close: async () => {
      keepCatalogsInMemory(false);
      await srv.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
