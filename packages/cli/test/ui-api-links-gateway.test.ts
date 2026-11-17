import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, type CatalogRecord } from "@maycombhq/core";
import { keepCatalogsInMemory, readCatalog } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

/**
 * ADR 0199, the second review (M1): a call paired with a gateway's route. The estate's join
 * walks the gateway: the route's forwarding call reaches the service behind it, so the catalog
 * has one Interface from the caller to the service (through the gateway) and the map draws that
 * arrow, never one to the gateway's box. The panel for the gateway's box must say so: the
 * pairing stands, the proxy forwards it, the arrow is caller → service; and it must not offer an
 * Apply for ever for an arrow to the gateway that is never drawn.
 *
 * Three invented Forge repos, with a real catalog: forge-desk (a caller written here), the proxy
 * and the service of `fixtures/gateway-facts/token-host/`. Files only.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const DESK = "forge-desk";
const PROXY = "forge_instruments_1-0";
const SERVICE = "forge-instruments";
const COMMIT: Record<string, string> = {
  [DESK]: "d35c0de",
  [PROXY]: "8a1c0de",
  [SERVICE]: "5e1f00d",
};
const ROUTE = "entry.get.forge-instruments-v1-instruments-ping";
const CLIENT = "src/main/java/forge/desk/InstrumentsClient.java";
const DESK_CALL = JSON.stringify({
  kind: "call",
  id: "call.get.ping",
  repo: DESK,
  commit: COMMIT[DESK],
  callType: "rest",
  method: "GET",
  path: "/v9/instruments/health",
  cite: {
    file: CLIENT,
    line: 5,
    value: "/v9/instruments/health",
    quote: '    return rest.getForObject("/v9/instruments/health", String.class);',
  },
  verified: "line",
  by: "assistant",
  conf: "declared",
});
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
      now: () => new Date("2026-11-17T10:00:00.000Z"),
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
const candidates = async (from: string, to: string) => {
  const r = await call(`/api/links/candidates?from=${from}&to=${to}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Api.LinkCandidatesView.parse(r.body);
};
const pair = async (from: string, to: string, c: string, api: string) => {
  const w = await call("/api/links/connect", "POST", {
    from,
    to: { repo: to },
    pairs: [{ call: c, api }],
  });
  expect(w.status, JSON.stringify(w.body)).toBe(200);
};
const arrows = async () =>
  (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records
    .filter((r): r is Iface => r.kind === "Interface")
    .map((i) => `${i.from} -> ${i.to}`)
    .sort();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-links-gateway-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  writeFileSync(
    manifest,
    `${readFileSync(manifest, "utf8").trimEnd()}\n  - id: ${DESK}\n    url: https://git.forge.example/forge/${DESK}.git\n    type: spring-boot\n    owner: team-desk\n`,
  );
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of [PROXY, SERVICE]) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  // The caller: one call to a path nothing of the estate serves, with no host: nothing joins it.
  mkdirSync(join(root, "workspace", DESK, "src/main/java/forge/desk"), { recursive: true });
  writeFileSync(
    join(root, "workspace", DESK, CLIENT),
    [
      "package forge.desk;",
      "",
      "class InstrumentsClient {",
      "  String ping() {",
      '    return rest.getForObject("/v9/instruments/health", String.class);',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "facts", `${DESK}.jsonl`), `${DESK_CALL}\n`);
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

describe("a call paired with a gateway's route (ADR 0199, M1)", () => {
  it("says the proxy forwards it and where its arrow goes, before and after Apply", async () => {
    // The proxy's route forwards to the service: a person's pairing, applied.
    await pair(PROXY, SERVICE, "call.get.instruments-ping", "entry.get.instruments-ping");
    await verify(PROXY);
    // The caller's call, paired with the proxy's route.
    await pair(DESK, PROXY, "call.get.ping", ROUTE);
    const before = (await candidates(DESK, PROXY)).calls.find((c) => c.fact === "call.get.ping")!;
    // Paired with the proxy; the join carries it on to the service; that arrow isn't drawn yet.
    expect(before).toMatchObject({
      status: "paired",
      paired: ROUTE,
      pairedBy: "pat",
      joins: SERVICE,
      onward: "forwarded",
      drawn: false,
    });
    await verify(DESK);
    // The premise: one arrow from the caller, to the service, and none to the proxy.
    expect((await arrows()).filter((a) => a.startsWith(`${DESK} `))).toEqual([
      `${DESK} -> ${SERVICE}`,
    ]);
    const view = await candidates(DESK, PROXY);
    expect(view.calls.find((c) => c.fact === "call.get.ping")).toMatchObject({
      status: "paired",
      paired: ROUTE,
      pairedBy: "pat",
      joins: SERVICE,
      onward: "forwarded",
      // The arrow it has (to the service) is on the map: nothing waits.
      drawn: true,
    });
    expect(view.applyPending).toBeUndefined();
    // From the service's box: it goes there already, and who paired it with which box is said.
    const there = (await candidates(DESK, SERVICE)).calls.find((c) => c.fact === "call.get.ping")!;
    expect(there).toMatchObject({
      status: "here",
      pairedBy: "pat",
      pairedWith: PROXY,
      onward: "forwarded",
    });
  });
});
