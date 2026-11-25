import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Item 0 of docs/plan/ai-first.md: the gateway-shape fixture (fixtures/gateway-shape/README.md).
 * Its true arrows are written by hand; this checks that every line they cite is the line they
 * say, so a model's pairing can be scored against them, and that the fixture keeps the shape it
 * exists for: the two modules serve the same path, and one target server has no host anywhere.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-shape");
const REPOS = join(FIX, "repos");

interface Arrow {
  from: string;
  method: string;
  path: string;
  to: string;
}
const arrows = (parse(readFileSync(join(FIX, "reference.yaml"), "utf8")) as { arrows: Arrow[] })
  .arrows;

/** `<repo> <file>:<line>` to that line's text. */
function lineAt(at: string): string {
  const m = /^(\S+) (.+):(\d+)$/.exec(at);
  if (!m) throw new Error(`not <repo> <file>:<line>: ${at}`);
  const file = join(REPOS, m[1]!, m[2]!);
  if (!existsSync(file)) throw new Error(`no file: ${at}`);
  const line = readFileSync(file, "utf8").split(/\r?\n/)[Number(m[3]) - 1];
  if (line === undefined) throw new Error(`no line: ${at}`);
  return line;
}

describe("the gateway-shape fixture", () => {
  it("cites, for each request, its flow's condition with its method and path suffix", () => {
    for (const a of arrows) {
      const line = lineAt(a.from);
      expect(line, a.from).toContain(`request.verb = "${a.method}"`);
      const suffix = a.path.replace(/^\/wallets\/v1/, "").replace(/\{[^}]+\}/g, "*");
      expect(line, a.from).toContain(`MatchesPath "${suffix}"`);
    }
  });

  it("cites, for each request that reaches a module, the route of that method", () => {
    for (const a of arrows.filter((x) => x.to !== "none")) {
      const line = lineAt(a.to).trim();
      expect(line.startsWith(`<${a.method.toLowerCase()}`), `${a.to}: ${line}`).toBe(true);
    }
    expect(arrows.filter((x) => x.to !== "none")).toHaveLength(4);
    expect(arrows.filter((x) => x.to === "none")).toHaveLength(1);
  });

  it("keeps its shape: both modules serve /accounts/{accountId} under /cxf/api, and legacy-core has no host", () => {
    const camel = "src/main/resources/OSGI-INF/blueprint/camel-context.xml";
    for (const m of ["forge-wallets-module", "forge-ledger-module"]) {
      const text = readFileSync(join(REPOS, m, camel), "utf8");
      expect(text, m).toContain('contextPath="/cxf/api"');
      expect(text, m).toContain('<rest path="/accounts">');
      expect(text, m).toContain('<get uri="/{accountId}">');
    }
    const config = readFileSync(
      join(REPOS, "forge-edge-config/env/test/targetservers.json"),
      "utf8",
    );
    expect(config).toContain('"wallets-fuse"');
    expect(config).not.toContain("legacy-core");
  });
});
