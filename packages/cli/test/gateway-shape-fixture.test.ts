import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Item 0 of docs/plan/ai-first.md: the gateway-shape fixture (fixtures/gateway-shape/README.md).
 * Its true arrows are written by hand. This traces each request through the fixture itself (the
 * proxy's route rules, the target's server, the server's host in forge-edge-config, the module
 * whose deploy file names that host, the route under contextPath + rest path + uri, after the
 * holds rewrite) and checks the reference says the same, so an arrow moved to the decoy module,
 * a line drifting, or a request left out fails here.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-shape");
const REPOS = join(FIX, "repos");
const PROXY = "forge-edge-wallets";
const FLOWS = "apiproxy/proxies/default.xml";
const CAMEL = "src/main/resources/OSGI-INF/blueprint/camel-context.xml";

interface Arrow {
  from: string;
  method: string;
  path: string;
  to: string;
}
const arrows = (parse(readFileSync(join(FIX, "reference.yaml"), "utf8")) as { arrows: Arrow[] })
  .arrows;

const read = (repo: string, file: string) =>
  readFileSync(join(REPOS, repo, file), "utf8").split(/\r?\n/);

/** A proxy path suffix pattern ("/accounts/*") matches a suffix ("/accounts/7"). */
const matches = (pattern: string, suffix: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) => part.split("*").join("[^/]+"))
      .join(".+")}$`,
  ).test(suffix);

/** Each flow of the proxy with a condition: its line, suffix pattern and verb. */
function flows() {
  return read(PROXY, FLOWS).flatMap((l, i) => {
    const m = /MatchesPath "([^"]+)"\) and \(request\.verb = "(\w+)"\)/.exec(l);
    return m ? [{ line: i + 1, pattern: m[1]!, verb: m[2]! }] : [];
  });
}

/** The target the proxy's route rules pick for a suffix: the first rule whose condition holds. */
function targetFor(suffix: string): string {
  const text = read(PROXY, FLOWS).join("\n");
  for (const m of text.matchAll(/<RouteRule name="[^"]+">([\s\S]*?)<\/RouteRule>/g)) {
    const cond = /MatchesPath "([^"]+)"/.exec(m[1]!);
    const target = /<TargetEndpoint>(\w+)<\/TargetEndpoint>/.exec(m[1]!)![1]!;
    if (!cond || matches(cond[1]!, suffix)) return target;
  }
  throw new Error(`no route for ${suffix}`);
}

/** A target's server, that server's hosts (every environment), and the module deployed there. */
function moduleFor(target: string): string | undefined {
  const t = read(PROXY, `apiproxy/targets/${target}.xml`).join("\n");
  const server = /<Server name="([^"]+)"\/>/.exec(t)![1]!;
  const envDir = join(REPOS, "forge-edge-config", "env");
  const hosts = readdirSync(envDir).flatMap((env) =>
    (
      JSON.parse(readFileSync(join(envDir, env, "targetservers.json"), "utf8")) as {
        name: string;
        host: string;
      }[]
    )
      .filter((s) => s.name === server)
      .map((s) => s.host),
  );
  if (!hosts.length) return undefined;
  const mods = readdirSync(REPOS).filter((r) =>
    ["test", "prod"].some((env) => {
      const f = join(REPOS, r, "deploy", `${env}.yaml`);
      return (
        existsSync(f) && hosts.includes((parse(readFileSync(f, "utf8")) as { host: string }).host)
      );
    }),
  );
  expect(mods, `the module for ${server}`).toHaveLength(1);
  return mods[0];
}

/** The line of the module's route for a method and a path after the context path. */
function routeLine(mod: string, method: string, path: string): number | undefined {
  let rest = "";
  for (const [i, l] of read(mod, CAMEL).entries()) {
    const r = /<rest path="([^"]*)">/.exec(l);
    if (r) rest = r[1]!;
    const v = new RegExp(`^\\s*<${method.toLowerCase()}(?: uri="([^"]*)")?>`).exec(l);
    if (v && matches(`${rest}${v[1] ?? ""}`.replace(/\{[^}]+\}/g, "*"), path)) return i + 1;
  }
  return undefined;
}

describe("the gateway-shape fixture", () => {
  it("names every request the proxy forwards, and only those", () => {
    const fromRef = arrows.map((a) => Number(/:(\d+)$/.exec(a.from)![1])).sort((a, b) => a - b);
    expect(fromRef).toEqual(flows().map((f) => f.line));
    // The last flow has no condition and answers 404: nothing else reaches a target.
    const proxy = read(PROXY, FLOWS).join("\n");
    expect(proxy).toMatch(
      /<Flow name="unknown-resource">\s*<Request>\s*<Step>\s*<Name>RF-NotFound<\/Name>/,
    );
    expect(proxy.lastIndexOf("<Flow ")).toBe(proxy.indexOf('<Flow name="unknown-resource">'));
  });

  it("traces each request to the module and route the reference names", () => {
    for (const a of arrows) {
      const f = flows().find((x) => `${PROXY} ${FLOWS}:${x.line}` === a.from);
      expect(f, a.from).toBeDefined();
      expect(f!.verb, a.from).toBe(a.method);
      const suffix = a.path.replace(/^\/wallets\/v1/, "").replace(/\{[^}]+\}/g, "7");
      expect(matches(f!.pattern, suffix), a.from).toBe(true);
      const mod = moduleFor(targetFor(suffix));
      if (!mod) {
        expect(a.to, a.from).toBe("none");
        continue;
      }
      // The wallets target rewrites holds to blocks before it forwards.
      const at = routeLine(mod, a.method, suffix.replace(/\/holds$/, "/blocks"));
      expect(at, `${a.from} reaches ${mod}`).toBeDefined();
      expect(a.to).toBe(`${mod} ${CAMEL}:${at}`);
    }
    expect(arrows.filter((x) => x.to !== "none")).toHaveLength(4);
  });

  it("keeps its shape: both modules serve /accounts/{accountId} under /cxf/api, and legacy-core has no host anywhere", () => {
    for (const m of ["forge-wallets-module", "forge-ledger-module"]) {
      const text = read(m, CAMEL).join("\n");
      expect(text, m).toContain('contextPath="/cxf/api"');
      expect(text, m).toContain('<rest path="/accounts">');
      expect(text, m).toContain('<get uri="/{accountId}">');
    }
    for (const env of ["test", "prod"]) {
      const f = join(REPOS, "forge-edge-config/env", env, "targetservers.json");
      expect(readFileSync(f, "utf8"), env).toContain('"wallets-fuse"');
      expect(readFileSync(f, "utf8"), env).not.toContain("legacy-core");
    }
    expect(read(PROXY, "apiproxy/targets/wallets.xml").join("\n")).toContain(
      "<Name>JS-RewriteHolds</Name>",
    );
    for (const p of ["VerifyAPIKey", "RF-NotFound", "JS-RewriteHolds"])
      expect(existsSync(join(REPOS, PROXY, "apiproxy/policies", `${p}.xml`)), p).toBe(true);
  });
});
