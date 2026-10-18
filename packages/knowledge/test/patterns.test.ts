import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffPatterns, readPage, scanPatterns } from "../src/index.js";
import { FORGE, forgeExpected, forgePack, HERE } from "./helpers.js";

const forgePage = () =>
  readPage({
    source: "forge-wiki",
    path: "../inputs/wiki/integration-patterns.md",
    content: readFileSync(join(FORGE, "inputs/wiki/integration-patterns.md"), "utf8"),
  });

describe("scanPatterns on the Forge integration-patterns page", () => {
  it("finds exactly the pattern codes of expected/inputs.yaml", () => {
    const { patterns } = forgeExpected<{ patterns: string[] }>("inputs.yaml");
    expect(scanPatterns(forgePage()).map((d) => d.code)).toEqual(patterns);
  });

  it("drafts each pattern with the fields the page states", () => {
    const drafts = scanPatterns(forgePage());
    expect(drafts[0]).toEqual({
      code: "S.GW.SOR",
      line: 7,
      draft: {
        schemaVersion: 1,
        code: "S.GW.SOR",
        name: "Synchronous via the gateway to a system of record",
        interaction: "sync",
        route: "gateway",
        controls: ["OAuth2 at the gateway", "timeout under 3 s", "circuit breaker"],
        resilience: { timeoutMs: 3000, circuitBreaker: true },
        source: "../inputs/wiki/integration-patterns.md",
        status: "to-review",
      },
    });
    expect(
      drafts.map((d) => [d.code, d.draft.route, d.draft.targetType, d.draft.resilience]),
    ).toEqual([
      ["S.GW.SOR", "gateway", undefined, { timeoutMs: 3000, circuitBreaker: true }],
      ["S.GW.VND", "gateway", "vendor", undefined],
      ["S.DIR.BFF", "direct", undefined, undefined],
      ["A.EB.PUB", "event-bus", undefined, undefined],
      ["D.JDBC", "jdbc", "data-store", undefined],
    ]);
  });

  it("agrees with the Forge org pack: nothing new, changed or missing", async () => {
    const op = await forgePack();
    expect(diffPatterns(scanPatterns(forgePage()), op.patterns)).toEqual({
      new: [],
      changed: [],
      missing: [],
      same: ["A.EB.PUB", "D.JDBC", "S.DIR.BFF", "S.GW.SOR", "S.GW.VND"],
    });
  });

  it("reports new, changed and missing patterns against the org pack", async () => {
    const op = await forgePack();
    const page = readPage({
      source: "w",
      path: "wiki/patterns-changed.md",
      content: readFileSync(join(HERE, "fixtures/patterns/patterns-changed.md"), "utf8"),
    });
    const diff = diffPatterns(scanPatterns(page), op.patterns);
    expect(diff.new.map((d) => d.code)).toEqual(["F.SFTP.VND"]);
    expect(diff.new[0]!.draft).toMatchObject({
      route: "sftp",
      targetType: "vendor",
      interaction: "async",
      controls: ["PGP-encrypted files", "checksum file"],
    });
    expect(diff.missing).toEqual(["D.JDBC"]);
    expect(diff.changed).toEqual([
      {
        code: "S.GW.SOR",
        line: 7,
        fields: [
          {
            field: "controls",
            page: ["OAuth2 at the gateway", "timeout under 2 s", "circuit breaker"],
            pack: ["OAuth2 at the gateway", "timeout under 3 s", "circuit breaker"],
          },
          { field: "resilience.timeoutMs", page: 2000, pack: 3000 },
        ],
      },
    ]);
    expect(diff.same).toEqual(["A.EB.PUB", "S.DIR.BFF", "S.GW.VND"]);
  });
});
