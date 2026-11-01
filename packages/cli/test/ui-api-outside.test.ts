import { cp, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { OUTSIDE_ADD_SPEC, uiOutsideRoutes } from "../src/ui-api-outside.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * The outside systems (plan item O4, ADR 0149): GET /api/outside gives, per system no estate repo
 * belongs to, who calls it (the catalog's Interfaces, the join's outside list and the calls its
 * spec matches, with the services behind a gateway's route), the operations its intaken spec
 * publishes, the calls that match nothing in it, its open questions, and how to add a spec when
 * it has none. On the invented Forge estate of fixtures/prototype-compare with Northwind Pay, an
 * invented vendor. Files only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");
const quiet = { out: () => undefined, err: () => undefined };

let srv: RunningServer;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-outside-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(root, d), { recursive: true });
  for (const r of await readdir(join(FX, "repos")))
    await cp(join(FX, "repos", r), join(root, "workspace", r), { recursive: true });
  // The catalog, as verify --write makes it.
  for (const r of ["forge-billing", "forge-partner-gateway", "forge-shop-bff"])
    await verifyCommand(root, r, { write: true }, quiet);
  // An Interface to the vendor written by hand, as a catalog from an earlier write might hold.
  await writeFile(
    join(root, "catalog/generated/interface/if-2df38586a85051f6.yaml"),
    [
      "schemaVersion: 3",
      "kind: Interface",
      "id: if-2df38586a85051f6",
      "status: current",
      "confidence: inferred",
      "conflicts: []",
      "direction: outbound",
      "evidence:",
      "  - { by: assistant, commit: aaa1111, line: 12, path: src/main/java/forge/shop/LoyaltyClient.java, repo: forge-shop-bff, side: caller, source: code }",
      "  - { by: assistant, commit: aaa1111, line: 4, path: src/main/resources/application.yml, repo: forge-shop-bff, side: caller, source: config }",
      "from: shop-bff",
      "method: GET",
      "normalizedPath: /v1/charges/{}",
      "sync: sync",
      "to: northwind-pay",
      "via: direct",
      "",
    ].join("\n"),
  );
  await raiseQuestions(
    root,
    [
      QuestionDraft.parse({
        question: "Does Northwind Pay still accept a capture after 7 days?",
        evidence: ["proxies/northwind-pay-v1/apiproxy/proxies/default.xml:8"],
      }),
    ],
    {
      step: "map",
      repo: "forge-partner-gateway",
      command: "atticus verify forge-partner-gateway",
      rerun: "atticus verify forge-partner-gateway",
      at: "2026-11-01T10:00:00Z",
    },
  );
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiOutsideRoutes(r, ctx),
  });
}, 120_000);
afterAll(() => srv?.close());

const get = async () => {
  const r = await fetch(`${srv.url}/api/outside`, { headers: { "X-Atticus-Token": srv.token } });
  expect(r.status).toBe(200);
  return Api.OutsideView.parse(await r.json());
};

describe("the outside systems", { timeout: 60_000 }, () => {
  it("lists every profile system no estate repo belongs to, and never an estate one", async () => {
    const v = await get();
    const ids = v.systems.map((s) => s.id);
    expect(ids).toContain("northwind-pay");
    expect(ids).toContain("audit");
    // Systems the manifest's repos belong to are the estate's.
    for (const own of ["shop", "billing", "platform"]) expect(ids).not.toContain(own);
  });

  it("gives a vendor's callers, its spec's operations with their calls, the calls matching nothing, and its questions", async () => {
    const nw = (await get()).systems.find((s) => s.id === "northwind-pay")!;
    expect(nw).toMatchObject({ name: "Northwind Pay", boundary: "vendor" });
    expect(nw.addSpec).toBeUndefined();
    expect(nw.spec).toMatchObject({
      path: "inputs/partner-specs/northwind-pay-openapi-v2.yaml",
      title: "Northwind Pay API",
      version: "2.0.0",
    });
    const ops = Object.fromEntries(nw.spec!.operations.map((o) => [o.id, o]));
    expect(ops["northwind-pay.post-charge"]).toMatchObject({ method: "POST", path: "/v1/charges" });
    expect(ops["northwind-pay.post-charge"]!.calls).toBeGreaterThanOrEqual(1);
    expect(ops["northwind-pay.post-refund"]!.calls).toBe(1);
    expect(ops["northwind-pay.get-charge-625a4a"]!.calls).toBe(0);
    // The gateway's forwarding calls, and the service behind the gateway's route.
    expect(nw.callers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "forge-partner-gateway",
          fact: "call.post.v1-charges",
          operation: "northwind-pay.post-charge",
        }),
        expect.objectContaining({
          repo: "forge-billing",
          operation: "northwind-pay.post-charge",
          through: {
            repo: "forge-partner-gateway",
            at: "proxies/northwind-pay-v1/apiproxy/proxies/default.xml:5",
          },
        }),
      ]),
    );
    // The capture the gateway forwards isn't in the vendor's spec.
    expect(nw.unmatched).toEqual([
      expect.objectContaining({
        repo: "forge-partner-gateway",
        method: "POST",
        path: "/v1/charges/{chargeId}/capture",
        message: expect.stringContaining("publishes no such operation"),
      }),
    ]);
    expect(nw.callers.some((c) => c.path === "/v1/charges/{chargeId}/capture")).toBe(true);
    // Its open questions: one naming it, and the one the write asked about calls to it.
    expect(nw.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "forge-partner-gateway",
          question: "Does Northwind Pay still accept a capture after 7 days?",
        }),
        expect.objectContaining({ question: expect.stringContaining("through northwind-pay") }),
      ]),
    );
    // A catalog Interface to the system is a caller too, at its call's line (not its config's).
    expect(nw.callers).toContainEqual(
      expect.objectContaining({
        repo: "forge-shop-bff",
        at: "src/main/java/forge/shop/LoyaltyClient.java:12",
        seen: ["interface"],
        interface: "if-2df38586a85051f6",
      }),
    );
    expect(nw.callers.some((c) => c.at === "src/main/resources/application.yml:4")).toBe(false);
  });

  it("says how to add a spec to a system with none", async () => {
    const audit = (await get()).systems.find((s) => s.id === "audit")!;
    expect(audit.spec).toBeUndefined();
    expect(audit.addSpec).toEqual(OUTSIDE_ADD_SPEC("audit"));
    expect(audit.addSpec![0]).toBe("atticus intake add <the audit spec file>");
    expect(audit.unmatched).toEqual([]);
  });
});
