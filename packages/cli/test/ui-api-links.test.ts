import { appendFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, parseCorrections } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiLinkRoutes } from "../src/ui-api-links.js";

/**
 * G1 (ADR 0174): connect two boxes call by call. On the invented Forge estate of
 * fixtures/prototype-compare: forge-billing gains a call whose path is the name of the field that
 * holds it (`captureChargePath`), so nothing joins it; the partner gateway's routes are the APIs
 * on the other side, and Northwind Pay (an invented vendor) has its spec in inputs/. Files only.
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
  root = await mkdtemp(join(tmpdir(), "atticus-links-"));
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
    extend: (r, ctx) => uiLinkRoutes(r, ctx, { now: () => new Date("2026-11-06T12:00:00.000Z") }),
  });
});
afterAll(() => srv?.close());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("connect two boxes (ADR 0174, G1)", () => {
  it("lists A's loose calls, B's routes and the route each call most likely is", async () => {
    const r = await call(
      "GET",
      "/api/links/candidates?from=forge-billing&to=forge-partner-gateway",
    );
    expect(r.status).toBe(200);
    const v = Api.LinkCandidatesView.parse(r.body);
    expect(v.toName).toBe("forge-partner-gateway");
    expect(v.apis.map((a) => a.path)).toContain("/partners/northwind/charges/{chargeId}/capture");
    const loose = v.calls.find((c) => c.fact === "call.post.capture-charge");
    expect(loose).toMatchObject({
      method: "POST",
      path: "captureChargePath",
      at: "src/main/java/forge/billing/PartnerClient.java:31",
      suggestion: {
        api: "entry.post.partners-northwind-charges-chargeid-capture",
        why: "names-alike",
      },
    });
    // A call the join already ties to the gateway isn't loose.
    expect(v.calls.some((c) => c.fact === "call.post.partners-northwind-charges")).toBe(false);
    expect(v.noCalls).toBeUndefined();
  });

  it("gives an outside system's operations from its spec, and says how to get them when there is none", async () => {
    const r = await call("GET", "/api/links/candidates?from=forge-billing&system=northwind-pay");
    expect(r.status).toBe(200);
    const v = Api.LinkCandidatesView.parse(r.body);
    expect(v.apis.length).toBeGreaterThan(0);
    expect(v.apis.every((a) => a.kind === "operation")).toBe(true);
    const none = await call(
      "GET",
      "/api/links/candidates?from=forge-billing&to=forge-checkout-prototype",
    );
    // A repo with no entries on record says how to read it first.
    expect([200, 404]).toContain(none.status);
    expect((await call("GET", "/api/links/candidates?from=forge-billing")).status).toBe(400);
    expect((await call("GET", "/api/links/candidates?from=nope&to=forge-billing")).status).toBe(
      404,
    );
  });

  it("previews a pair without writing, then writes one link line, and Undo removes exactly it", async () => {
    const body = {
      from: "forge-billing",
      to: { repo: "forge-partner-gateway" },
      pairs: [
        {
          call: "call.post.capture-charge",
          api: "entry.post.partners-northwind-charges-chargeid-capture",
        },
      ],
    };
    const file = join(root, "facts/forge-billing.corrections.jsonl");
    const p = await call("POST", "/api/links/connect", { ...body, preview: true });
    expect(p.status).toBe(200);
    const pv = Api.ConnectLinksResult.parse(p.body);
    expect(pv).toMatchObject({ written: false, file: "facts/forge-billing.corrections.jsonl" });
    expect(pv.verify).toBe("atticus verify forge-billing --write");
    await expect(readFile(file, "utf8")).rejects.toThrow();

    const w = Api.ConnectLinksResult.parse((await call("POST", "/api/links/connect", body)).body);
    expect(w.written).toBe(true);
    const text = await readFile(file, "utf8");
    const { corrections, bad } = parseCorrections(text);
    expect(bad).toEqual([]);
    expect(corrections).toEqual([
      {
        schemaVersion: 1,
        fact: "call.post.capture-charge",
        target: {
          kind: "call",
          file: "src/main/java/forge/billing/PartnerClient.java",
          line: 31,
          value: "captureChargePath",
        },
        action: "link",
        link: {
          repo: "forge-partner-gateway",
          entry: "entry.post.partners-northwind-charges-chargeid-capture",
          method: "POST",
          path: "/partners/northwind/charges/{chargeId}/capture",
        },
        by: "pat",
        at: "2026-11-06T12:00:00.000Z",
      },
    ]);
    // The join reads it: the call is paired now, listed so it can be undone.
    const after = Api.LinkCandidatesView.parse(
      (await call("GET", "/api/links/candidates?from=forge-billing&to=forge-partner-gateway")).body,
    );
    expect(after.calls.find((c) => c.fact === "call.post.capture-charge")).toMatchObject({
      status: "paired",
      paired: "entry.post.partners-northwind-charges-chargeid-capture",
    });

    // G4 (ADR 0176): the pairing as a draft rule for every repo of forge-billing's type.
    const fr = await call("POST", "/api/reading-rules/from-pairing", {
      repo: "forge-billing",
      line: w.lines[0],
    });
    expect(fr.status).toBe(200);
    const made = Api.RuleFromPairingResult.parse(fr.body);
    expect(made).toMatchObject({
      file: "org-pack/reading-rules/types/spring-boot.yaml",
      key: "paths-to-forge-partner-gateway",
      activate: "atticus rules activate paths-to-forge-partner-gateway --type spring-boot",
    });
    expect(made.rule).toContain("`captureChargePath`");
    expect(await readFile(join(root, made.file), "utf8")).toContain("status: draft");
    // A line that isn't on file in the repo's corrections is refused.
    expect(
      (
        await call("POST", "/api/reading-rules/from-pairing", {
          repo: "forge-billing",
          line: w.lines[0]!.replace('"by":"pat"', '"by":"someone-else"'),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/reading-rules/from-pairing", {
          repo: "forge-billing",
          line: w.lines[0],
        })
      ).status,
    ).toBe(409);
    const u = await call("POST", "/api/facts/forge-billing/corrections/undo", { line: w.lines[0] });
    expect(u.status).toBe(200);
    expect((await readFile(file, "utf8")).trim()).toBe("");
    expect(
      (await call("POST", "/api/facts/forge-billing/corrections/undo", { line: w.lines[0] }))
        .status,
    ).toBe(404);
  });

  it("refuses a pair whose call or API isn't on record, and a rule with no open question", async () => {
    const base = { from: "forge-billing", to: { repo: "forge-partner-gateway" } };
    expect(
      (await call("POST", "/api/links/connect", { ...base, pairs: [{ call: "nope", api: "x" }] }))
        .status,
    ).toBe(404);
    expect((await call("POST", "/api/links/connect", { ...base, pairs: [] })).status).toBe(400);
    expect((await call("POST", "/api/links/connect", { ...base, rule: true })).status).toBe(409);
  });
});
