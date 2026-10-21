import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack, orgPackJsonSchemas, ScanSettings } from "../src/index.js";

const good = {
  schemaVersion: 1,
  repo: "forge-ledger",
  exclude: [{ path: "docs/**", why: "a generated documentation site", at: "docs/index.html:1" }],
  prefixes: [
    {
      paths: ["src/main/java/**"],
      prefix: "/ledger",
      why: "server.servlet.context-path",
      at: "src/main/resources/application.yml:4",
      value: "/ledger",
    },
  ],
  clients: [
    {
      paths: ["web/src/**"],
      base: "https://ledger.forge.internal/ledger/",
      names: ["environment.LEDGER_API_URL"],
      why: "the ledger API's URL in the build's environment file",
      at: "web/src/environments/environment.ts:3",
      value: "https://ledger.forge.internal/ledger/",
    },
  ],
};

describe("scan settings per repo (ADR 0075)", () => {
  it("parses a repo's settings, with defaults for what isn't given", () => {
    expect(ScanSettings.parse(good)).toEqual(good);
    expect(ScanSettings.parse({ schemaVersion: 1, repo: "x" })).toEqual({
      schemaVersion: 1,
      repo: "x",
      exclude: [],
      prefixes: [],
      clients: [],
    });
  });

  it("takes client bases as a URL or a path, and refuses anything else (ADR 0076)", () => {
    const client = good.clients[0]!;
    const ok = (patch: object) =>
      ScanSettings.safeParse({ ...good, clients: [{ ...client, ...patch }] }).success;
    expect(ok({ base: "/ledger/api" })).toBe(true);
    expect(ok({ base: "http://localhost:9966/petclinic/api/" })).toBe(true);
    expect(ok({ base: "ledger/api" })).toBe(false);
    expect(ok({ base: "https://" })).toBe(false);
    expect(ok({ names: ["environment. LEDGER"] })).toBe(false);
    expect(ok({ names: ["${BASE}"] })).toBe(false);
    expect(ok({ paths: [] })).toBe(false);
    // Names may be left out: the entry then covers only paths with no host.
    const { names: _n, ...noNames } = client;
    expect(ScanSettings.parse({ ...good, clients: [noNames] }).clients[0]!.names).toEqual([]);
  });

  it("refuses an entry without a citation, a prefix that isn't a path, or an unsafe glob", () => {
    const bad = (patch: object) => ScanSettings.safeParse({ ...good, ...patch }).success;
    expect(bad({ prefixes: [{ ...good.prefixes[0], at: "application.yml" }] })).toBe(false);
    expect(bad({ prefixes: [{ ...good.prefixes[0], prefix: "ledger" }] })).toBe(false);
    expect(bad({ exclude: [{ path: "../elsewhere/**", why: "x", at: "a:1" }] })).toBe(false);
    expect(bad({ exclude: [{ path: "/abs/**", why: "x", at: "a:1" }] })).toBe(false);
  });

  it("loads org-pack/scan/<repo>.yaml and reports a file whose repo doesn't match its name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-scan-settings-"));
    await mkdir(join(dir, "scan"), { recursive: true });
    await writeFile(join(dir, "scan", "forge-ledger.yaml"), JSON.stringify(good));
    await writeFile(
      join(dir, "scan", "other.yaml"),
      JSON.stringify({ ...good, repo: "forge-gateway" }),
    );
    const op = await loadOrgPack(dir);
    expect(op.scanSettings.map((s) => s.repo)).toEqual(["forge-ledger"]);
    expect(op.problems).toContainEqual(
      expect.objectContaining({
        file: "scan/other.yaml",
        message: "is for forge-gateway; name it scan/forge-gateway.yaml",
      }),
    );
    expect(Object.keys(orgPackJsonSchemas())).toContain("ScanSettings");
  });
});
