import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { scanEstate, type EstateScan } from "../src/index.js";

/**
 * Three gateway products, none read by a built-in extractor the way this estate uses them, each
 * read through an org-pack dialect (ADR 0058, fixtures/gateways). Every call must join end to
 * end: caller, gateway route, callee.
 */
const GW = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/gateways");

let scan: EstateScan;
beforeAll(async () => {
  scan = await scanEstate({
    root: await mkdtemp(join(tmpdir(), "atticus-gateways-")),
    orgPack: join(GW, "metarepo/org-pack"),
    repoDir: (id) => join(GW, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    scannedAt: "2026-10-19T12:00:00Z",
  });
}, 120_000);

type R = Record<string, unknown> & { kind: string; id: string };
const recs = () => scan.records as unknown as R[];

describe("any gateway, read through dialects (ADR 0058)", () => {
  it("scans with no problems: every dialect's own tests pass", () => {
    expect(scan.problems).toEqual([]);
  });

  it("reads each gateway's routes: Apigee target servers, Kong services, APIM APIs", () => {
    expect(
      recs()
        .filter((r) => r.kind === "GatewayRoute")
        .map((r) => `${r.id} ${String(r.basepath)} -> ${String(r.target)}`)
        .sort(),
    ).toEqual([
      "apim-limits /limits -> https://limits.tide.internal",
      "gw-payments-api /payments -> https://payments.tide.internal:443",
      "kong-ledger-public-ledger /ledger -> http://ledger.tide.internal:8080/api",
      "kong-ledger-public-ledger-v1 /ledger-v1 -> http://ledger.tide.internal:8080/api",
      "kong-status-status /status -> http://status.tide.internal",
    ]);
  });

  it("joins every call through its gateway to the service behind it, verified at both ends", () => {
    expect(
      recs()
        .filter((r) => r.kind === "Interface")
        .map(
          (r) =>
            `${String(r.from)}->${String(r.to)} ${String(r.via)} ${String(r.route)} ${String(r.method)} ${String(r.normalizedPath)} ${String(r.confidence)}`,
        )
        .sort(),
    ).toEqual([
      "cards-svc->ledger-svc gateway kong-ledger-public-ledger POST /api/entries verified",
      "cards-svc->limits-svc gateway apim-limits GET /v1/limits/{} verified",
      "cards-svc->payments-svc gateway gw-payments-api POST /v2/charges verified",
    ]);
    expect(
      recs().filter((r) => r.kind === "Unresolved" && r.unresolvedKind === "http-call"),
    ).toEqual([]);
  });
});
