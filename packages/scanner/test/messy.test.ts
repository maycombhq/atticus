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
      "tide-bff",
      "tide-cards",
      "tide-gateway",
      "tide-infra",
      "tide-payments",
      "tide-web",
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
    // The controller on constants is read through ApiPaths.java, in the same repo: verified.
    expect(loose("http-endpoint")).toEqual([]);
    const cards = recs().find(
      (r) =>
        r.kind === "Endpoint" && r.component === "cards-svc" && r.pathOrTopic === "/cards/{id}",
    );
    expect(cards?.confidence).toBe("verified");
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
    expect(scan.coverage).toHaveLength(6);
  });

  // ---- Phase 3: the house starter, read through its framework model (ADR 0054;
  // org-pack/frameworks/tide-platform.yaml, written by a person).

  it("reads a controller on the house starter's @InternalApi/@Op as an endpoint, inferred", () => {
    const ep = recs().find(
      (r) => r.kind === "Endpoint" && r.method === "GET" && r.pathOrTopic === "/statements/{id}",
    );
    expect(ep?.component).toBe("cards-svc");
    // The model says what @InternalApi means, and a person wrote it: not verified yet.
    expect(ep?.confidence).toBe("inferred");
  });

  it("reads a call through the platform's wrapper client, with the service id's URL", () => {
    expect(loose("http-call")).toContain("POST https://audit.tide.internal/audit/events");
  });

  // ---- ADR 0055: a house framework in another language. Lantern (React SPA and Node BFF),
  // read through org-pack/frameworks/tide-lantern.yaml, written by a person.

  it("reads the SPA's calls through Lantern's hook and client, to the BFF's declared host", () => {
    const web = recs()
      .filter((r) => r.kind === "Unresolved" && r.owner === "web")
      .map((r) => String(r.raw))
      .sort();
    // Joined calls leave no loose end; what is left is nothing the model didn't explain.
    expect(web).toEqual([]);
    expect(
      interfaces()
        .filter((i) => i.startsWith("web->"))
        .sort(),
    ).toEqual([
      "web->web-bff direct GET /statements/{} verified",
      "web->web-bff direct POST /limits verified",
    ]);
  });

  it("reads the BFF's Lantern routes as endpoints, inferred (a person wrote the model)", () => {
    const eps = recs()
      .filter(
        (r) => r.kind === "Endpoint" && r.component === "web-bff" && r.endpointType === "rest",
      )
      .map((r) => `${r.method} ${r.pathOrTopic} ${r.confidence}`)
      .sort();
    expect(eps).toEqual(["GET /statements/{id} inferred", "POST /limits inferred"]);
  });

  it("follows the chain across languages: SPA (TSX) to BFF (TS) to the house Java service", () => {
    expect(interfaces()).toContain("web-bff->cards-svc direct GET /statements/{} verified");
  });

  // ---- ADR 0056: an infra repo, read through a dialect. Topics come from the platform team's
  // house Terraform module (org-pack/dialects/tide-infra.yaml).

  it("reads topics provisioned through the house Terraform module, with variables resolved", () => {
    const topics = recs()
      .filter((r) => r.kind === "Endpoint" && r.endpointType === "event-topic")
      .map((r) => `${r.component} ${r.pathOrTopic} ${r.confidence}`)
      .sort();
    // tfvars wins over the variable's default; the public VPC module is left alone.
    expect(topics).toEqual([
      "cards-svc cards.statements.prod verified",
      "web-bff web.limits.prod verified",
    ]);
  });
});
