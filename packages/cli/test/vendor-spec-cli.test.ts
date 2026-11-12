import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { type CatalogRecord } from "@maycombhq/core";
import { buildEstate } from "@maycombhq/diagrams";
import { readCatalog } from "@maycombhq/scanner";
import {
  outsideView,
  OUTSIDE_ALIAS_CLASH,
  OUTSIDE_SPEC_HOST_CLASH,
} from "../src/ui-api-outside.js";
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

/**
 * Beta.27 (a user's Outside systems page and Map, re-made with invented names): an Apigee proxy
 * repo fronts Northwind Pay (an invented vendor) through the TargetEndpoint URL
 * `@targetVendorUrl@`, which config.json sets per environment to `https://<host>/api/v1`; the
 * vendor's spec (`inputs/inbox/northwind-pay-openapi.yaml`) publishes `/api/{version}/...`; an
 * onboarding service calls the proxy's base path on the gateway's host
 * (`fixtures/gateway-facts/vendor-spec/`). Each forwarding call lands on the operation it reaches
 * (a wildcard route on every one under it), only a call that fits none is listed as matching
 * nothing, the service is listed behind the proxy's route, never as calling the vendor directly,
 * and the vendor is one box on the Map with no "No repo known". Files only, no network.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-spec");
const COMMIT: Record<string, string> = {
  "northwind_accounts_1-0": "8888aaa",
  "forge-onboarding": "9999bbb",
};
const PROXY = "northwind_accounts_1-0";
const AT = new Date("2026-11-12T10:00:00.000Z");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-vendor-spec-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(FIX, "inputs"), join(root, "inputs"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    cpSync(join(FIX, "facts", `${r}.jsonl`), join(root, "facts", `${r}.jsonl`));
  }
  return root;
}

async function verify(root: string, repo: string): Promise<void> {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
}

const golden = (name: string, got: unknown) => {
  // UPDATE_GOLDEN=1 writes what the build gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN) writeFileSync(join(FIX, "expected", name), stringify(got));
  return parse(readFileSync(join(FIX, "expected", name), "utf8")) as unknown;
};
const catalogOf = async (root: string) =>
  (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records;

let root: string;
beforeAll(async () => {
  root = metarepo();
  for (const r of Object.keys(COMMIT)) await verify(root, r);
}, 180_000);

describe(
  "the Outside systems page for a vendor behind a gateway (beta.27)",
  { timeout: 60_000 },
  () => {
    it("lands each forwarding call on the operation it reaches, through the target URL's /api/v1", async () => {
      const nw = (await outsideView(root)).systems.find((s) => s.id === "northwind-pay")!;
      expect(nw.spec?.path).toBe("inputs/inbox/northwind-pay-openapi.yaml");
      const calls = Object.fromEntries(
        nw.spec!.operations.map((o) => [`${o.method} ${o.path}`, o.calls]),
      );
      // The onboarding service's call reaches the instruments operation through the proxy's route.
      expect(calls).toEqual({
        "POST /api/{version}/account_instruments": 2,
        "GET /api/{version}/accounts/{account_guid}": 1,
        "GET /api/{version}/accounts/balances": 2,
        "GET /api/{version}/cards/{card_guid}/pin": 1,
        "POST /api/v1/auth/login": 0,
      });
      // Only the call that truly fits no operation matches nothing; no question is asked.
      expect(nw.unmatched.map((u) => [u.at, u.message])).toEqual([
        [
          "apiproxy/proxies/default.xml:16",
          "northwind-accounts-proxy forwards GET /api/v1/bulkorders to Northwind Pay, whose spec publishes no such operation",
        ],
      ]);
      expect(nw.ambiguous).toEqual([]);
      expect(nw.notes).toBeUndefined();
      const view = nw.callers.map((c) => ({
        repo: c.repo,
        at: c.at,
        seen: c.seen,
        ...(c.operation ? { operation: c.operation } : {}),
        ...(c.operations ? { operations: c.operations } : {}),
        ...(c.through ? { through: c.through } : {}),
      }));
      expect(view).toEqual(golden("outside-callers.yaml", view));
    });

    it("lists the service that calls the gateway's base path behind the proxy's route, never as calling the vendor", async () => {
      const nw = (await outsideView(root)).systems.find((s) => s.id === "northwind-pay")!;
      const onboarding = nw.callers.filter((c) => c.repo === "forge-onboarding");
      expect(onboarding).toHaveLength(1);
      expect(onboarding[0]).toMatchObject({
        operation: "northwind-pay.post-account-instrument",
        through: { repo: PROXY, at: "apiproxy/proxies/default.xml:4" },
      });
      expect(nw.unmatched.some((u) => u.repo === "forge-onboarding")).toBe(false);
    });

    it("says so plainly when the gateway's host is one of the vendor's aliases", async () => {
      const r = metarepo();
      const p = join(r, "org-pack", "profiles", "forge", "profile.yaml");
      writeFileSync(
        p,
        readFileSync(p, "utf8").replace(
          "aliases: [api.northwind-pay.example, devapi.northwind-pay.example]",
          "aliases: [api.northwind-pay.example, devapi.northwind-pay.example, gw.forge.example]",
        ),
      );
      for (const x of Object.keys(COMMIT)) await verify(r, x);
      const nw = (await outsideView(r)).systems.find((s) => s.id === "northwind-pay")!;
      expect(nw.notes).toEqual([OUTSIDE_ALIAS_CLASH("Northwind Pay", "gw.forge.example", PROXY)]);
      // The service's call is still the proxy's route's, not the vendor's.
      expect(nw.callers.filter((c) => c.repo === "forge-onboarding" && !c.through)).toEqual([]);
    }, 180_000);

    it("says so plainly when a repo lists one of the hosts the vendor's spec serves on", async () => {
      const r = metarepo();
      // The spec serves on a sandbox host the profile's aliases don't name, and the manifest lists
      // it under the onboarding service's hosts by mistake.
      const s = join(r, "inputs", "inbox", "northwind-pay-openapi.yaml");
      writeFileSync(
        s,
        readFileSync(s, "utf8").replace(
          "  - url: https://api.northwind-pay.example\n",
          "  - url: https://api.northwind-pay.example\n  - url: https://sandbox.northwind-pay.example\n",
        ),
      );
      const m = join(r, "org-pack", "profiles", "forge", "repos.manifest.yaml");
      writeFileSync(
        m,
        readFileSync(m, "utf8").replace(
          "hosts: [onboarding.forge.internal]",
          "hosts: [onboarding.forge.internal, sandbox.northwind-pay.example]",
        ),
      );
      for (const x of Object.keys(COMMIT)) await verify(r, x);
      const nw = (await outsideView(r)).systems.find((s) => s.id === "northwind-pay")!;
      expect(nw.notes).toEqual([
        OUTSIDE_SPEC_HOST_CLASH(
          "Northwind Pay",
          "sandbox.northwind-pay.example",
          "forge-onboarding",
          "inputs/inbox/northwind-pay-openapi.yaml",
        ),
      ]);
      expect(nw.notes![0]).toContain("take it out of forge-onboarding's hosts");
    }, 180_000);
  },
);

type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
describe("the vendor on the Map (beta.27)", { timeout: 60_000 }, () => {
  it("draws each forwarding call to the vendor system with the path it receives", async () => {
    const arrows = (await catalogOf(root))
      .filter((r): r is Iface => r.kind === "Interface" && r.from === "northwind-accounts-proxy")
      .map((i) => [i.to, i.method, i.normalizedPath])
      .sort();
    expect(arrows).toEqual([
      ["northwind-pay", "GET", "/api/v1/accounts/*"],
      ["northwind-pay", "GET", "/api/v1/accounts/balances"],
      ["northwind-pay", "GET", "/api/v1/bulkorders"],
      ["northwind-pay", "GET", "/api/v1/cards/*/pin"],
      ["northwind-pay", "POST", "/api/v1/account_instruments"],
    ]);
  });

  it("draws the prod-like environment's path when the environments' target paths differ (the review of beta.27)", async () => {
    // The per-environment case (README): one host for both, /api/v1 in dv and /api/v2 in prod.
    const r = metarepo();
    const files = [join(r, "workspace", PROXY, "config.json"), join(r, "facts", `${PROXY}.jsonl`)];
    for (const f of files)
      writeFileSync(
        f,
        readFileSync(f, "utf8")
          .replaceAll(
            "https://api.northwind-pay.example/api/v1",
            "https://api.northwind-pay.example/api/v2",
          )
          .replaceAll(
            "https://devapi.northwind-pay.example/api/v1",
            "https://api.northwind-pay.example/api/v1",
          ),
      );
    for (const x of Object.keys(COMMIT)) await verify(r, x);
    const arrows = (await catalogOf(r))
      .filter((x): x is Iface => x.kind === "Interface" && x.from === "northwind-accounts-proxy")
      .map((i) => [i.to, i.method, i.normalizedPath])
      .sort();
    expect(arrows).toEqual([
      ["northwind-pay", "GET", "/api/v2/accounts/*"],
      ["northwind-pay", "GET", "/api/v2/accounts/balances"],
      ["northwind-pay", "GET", "/api/v2/bulkorders"],
      ["northwind-pay", "GET", "/api/v2/cards/*/pin"],
      ["northwind-pay", "POST", "/api/v2/account_instruments"],
    ]);
    // The Outside page: each call reaches the same operation in both; only bulkorders, in each.
    const nw = (await outsideView(r)).systems.find((s) => s.id === "northwind-pay")!;
    expect(nw.unmatched.map((u) => u.message)).toEqual([
      "northwind-accounts-proxy forwards GET /api/v2/bulkorders in prod (/api/v1/bulkorders in dv) to Northwind Pay, whose spec publishes no such operation",
    ]);
    expect(nw.ambiguous).toEqual([]);
  }, 180_000);

  it("draws no arrow by a host alias two outside systems list (the review of beta.27)", async () => {
    const r = metarepo();
    const p = join(r, "org-pack", "profiles", "forge", "profile.yaml");
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "environments:",
        [
          "  - id: northwind-sandbox",
          "    name: Northwind Sandbox",
          "    boundary: vendor",
          "    owner: team-onboarding",
          "    aliases: [devapi.northwind-pay.example]",
          "environments:",
        ].join("\n"),
      ),
    );
    for (const x of Object.keys(COMMIT)) await verify(r, x);
    const records = await catalogOf(r);
    const drawn = records
      .filter((x): x is Iface => x.kind === "Interface" && x.from === "northwind-accounts-proxy")
      .map((i) => i.to);
    expect(drawn.filter((t) => t === "northwind-pay" || t === "northwind-sandbox")).toEqual([]);
    expect(
      records.filter((x) => x.kind === "Component" && x.id.startsWith("devapi")).map((x) => x.id),
    ).toEqual([]);
  }, 180_000);

  it("keeps the vendor one box: no component split off by a host label or a TargetEndpoint's name, no repo gaps", async () => {
    const records = await catalogOf(root);
    const inVendor = records.filter(
      (r) => r.kind === "Component" && (r as { system?: string }).system === "northwind-pay",
    );
    expect(inVendor.map((c) => c.id)).toEqual([]);
    const h = buildEstate(records);
    const vendorParts = [...h.nodes.values()].filter(
      (n) => n.parent === "system:northwind-pay" && n.kind === "component",
    );
    for (const n of vendorParts) {
      expect(n.gaps).not.toContain("no-repo");
      expect(n.gaps).not.toContain("inferred");
    }
  });
});
