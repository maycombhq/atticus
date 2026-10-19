import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { scanEstate, type EstateScan } from "../src/index.js";

/**
 * The phase 2 gate: the messy estate (fixtures/messy), an invented bank whose teams write code
 * the way real ones do. A scan must finish, make no verified fact the code doesn't spell out,
 * show every client call it found, join through the gateway only on its declared host, keep
 * no secret and say how much it joined. What it can't read yet is listed as known gaps.
 */

const MESSY = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messy");
const T = 120_000;

let scan: EstateScan;
beforeAll(async () => {
  scan = await scanEstate({
    root: await mkdtemp(join(tmpdir(), "atticus-messy-")),
    orgPack: join(MESSY, "metarepo/org-pack"),
    repoDir: (id) => join(MESSY, "repos", id),
    repoState: async () => ({ commit: "b".repeat(40), dirty: false }),
    cache: null,
    scannedAt: "2026-10-19T12:00:00Z",
  });
}, T);

type R = CatalogRecord & Record<string, unknown>;
const recs = () => scan.records as R[];
const loose = (kind: string) =>
  recs()
    .filter((r) => r.kind === "Unresolved" && r.unresolvedKind === kind)
    .map((r) => String(r.raw))
    .sort();
const interfaces = () =>
  recs()
    .filter((r) => r.kind === "Interface")
    .map(
      (r) => `${r.from}->${r.to} ${r.via} ${r.method ?? ""} ${r.normalizedPath} ${r.confidence}`,
    );

describe("the messy estate (phase 2 gate)", () => {
  it("scans every repo with no problems, a broken template file included", () => {
    expect(scan.problems).toEqual([]);
    expect(scan.repos.map((r) => r.repo).sort()).toEqual([
      "tide-cards",
      "tide-gateway",
      "tide-payments",
    ]);
  });

  it("makes no verified fact from a name the code doesn't spell out", () => {
    const verified = recs().filter(
      (r) => (r.kind === "Endpoint" || r.kind === "Interface") && r.confidence === "verified",
    );
    for (const r of verified) {
      const path = String(r.pathOrTopic ?? r.normalizedPath ?? "");
      expect(path, r.id).not.toMatch(/\$\{|[A-Z][A-Za-z]+\.[A-Z_]+/);
    }
    // The controller on constants is a loose end that shows its names.
    expect(loose("http-endpoint")).toEqual(["GET ${ApiPaths.CARDS}/${ApiPaths.BY_ID}"]);
  });

  it("joins the @Value base URL + constant path through the declared gateway host, verified", () => {
    expect(interfaces()).toContain("cards-svc->payments-svc gateway POST /v2/payments verified");
  });

  it("doesn't join a partner's API that shares the gateway's basepath, and says so", () => {
    expect(loose("http-call")).toContain(
      "POST https://api.partner-bank.example/payments-api/v2/payments",
    );
    expect(scan.notes.some((n) => n.includes("api.partner-bank.example"))).toBe(true);
  });

  it("doesn't join a relative /health poll to whichever service serves /health", () => {
    expect(interfaces().filter((i) => i.includes("/health"))).toEqual([]);
  });

  it("shows topics and queues built from constants as loose ends, and reads JMS", () => {
    expect(loose("event-publish")).toEqual(["${Topics.CARD_ISSUED}"]);
    expect(loose("mq-publish")).toEqual(["${Queues.ORDERS}"]);
    expect(loose("mq-subscribe")).toEqual(["CARDS.REPLY"]);
  });

  it("reads the Kotlin controller", () => {
    expect(
      recs().some(
        (r) =>
          r.kind === "Endpoint" &&
          r.component === "cards-svc" &&
          r.method === "GET" &&
          r.pathOrTopic === "/limits/{id}",
      ),
    ).toBe(true);
  });

  it("keeps no password from the datasource URL", () => {
    expect(JSON.stringify(scan.records)).not.toContain("Tide-Fixture-Pw1");
    expect(loose("db-connection")).toEqual(["jdbc:oracle:thin:@db.tide.internal:1521/CARDS"]);
  });

  it("reports coverage for every repo", () => {
    const cards = scan.coverage.find((c) => c.repo === "tide-cards")!;
    expect(cards.joined).toBeGreaterThanOrEqual(1);
    expect(cards.open).toBeGreaterThanOrEqual(5);
    expect(scan.coverage).toHaveLength(3);
  });

  // ---- Known gaps, for phase 3 (house frameworks). Each fails today; when one passes, the
  // gap is closed: turn it into an ordinary test.

  it.fails(
    "phase 3 gap: a controller on the house starter's @InternalApi/@Op is an endpoint",
    () => {
      expect(
        recs().some(
          (r) => r.kind === "Endpoint" && String(r.pathOrTopic).startsWith("/statements"),
        ),
      ).toBe(true);
    },
  );

  it.fails(
    "phase 3 gap: a call through the platform's wrapper client is at least a loose end",
    () => {
      expect(loose("http-call").some((x) => x.includes("/audit/events"))).toBe(true);
    },
  );
});
