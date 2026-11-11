import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONVENTIONS, Fact, parseFacts } from "@maycombhq/core";
import { dirSource, verifyFacts, type FileSource } from "../src/index.js";
import { configLineProblem, helperBuildsKey } from "../src/settings-path.js";

/**
 * Beta.25 review of the verifier's settings checks: a config fact's value is the line's whole
 * value (never a prefix of a longer host), a deploy tool's token is its configuration's (its
 * environment and its file), a placeholder call is cited on code that names the key's segment
 * whole, a secret in a token's part is refused, and the bundle folders are the org pack's. All
 * invented (Forge, Northwind; `.example` hosts).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-proxy");
const R = "northwind_wallets_1-0";
const fixtureFacts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${R}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const memory = (files: Record<string, string>): FileSource => ({
  list: () => Object.keys(files),
  read: (p) => files[p],
});

describe("a config fact's value, against its line", () => {
  const files: Record<string, string> = {
    "app.yml":
      "vendor:\n  url: https://api.northwind.example.attacker.example/v1\n  ok: 'https://api.northwind.example' # the vendor\n",
    "app.properties":
      "vendor.url=https://api.northwind.example.evil.example/v1\nvendor.ok = https://api.northwind.example\n",
    "w/config.json":
      '{ "xpath": "/TargetEndpoint/HTTPTargetConnection/URL", "value": "https://api.northwind.example.evil.example/v1" }\n{ "xpath": "/TargetEndpoint/HTTPTargetConnection/URL", "value": "https://api.northwind.example" }\n',
  };
  const linesOf = (p: string) => files[p]?.split("\n");
  const listed = () => [...Object.keys(files), "w/apiproxy/targets/default.xml"];
  const problem = (key: string, value: string, file: string, line: number) =>
    configLineProblem({ key, value, cite: { file, line } }, linesOf, listed);

  it("is refused when the line sets a longer value it only starts (YAML)", () => {
    expect(problem("vendor.url", "https://api.northwind.example", "app.yml", 2)).toBeDefined();
  });
  it("is refused when the line sets a longer value it only starts (properties)", () => {
    expect(
      problem("vendor.url", "https://api.northwind.example", "app.properties", 1),
    ).toBeDefined();
  });
  it("is refused when the token sets a longer value it only starts", () => {
    expect(
      problem(
        "/TargetEndpoint/HTTPTargetConnection/URL",
        "https://api.northwind.example",
        "w/config.json",
        1,
      ),
    ).toBeDefined();
  });
  it("is kept when the line's whole value is it, quotes, spacing and a comment aside", () => {
    expect(problem("vendor.ok", "https://api.northwind.example", "app.yml", 3)).toBeUndefined();
    expect(
      problem("vendor.ok", "https://api.northwind.example", "app.properties", 2),
    ).toBeUndefined();
    expect(
      problem(
        "/TargetEndpoint/HTTPTargetConnection/URL",
        "https://api.northwind.example",
        "w/config.json",
        2,
      ),
    ).toBeUndefined();
  });
});

describe("a placeholder call a helper puts together", () => {
  const files: Record<string, string> = {
    "README.md": "# Wallets\nThe createWallet path is set in application.yml\n",
    "src/W.java": 'log.warn("createWallet failed");\nclient.post(uris.get("createWallet"));\n',
    "src/V.java": "return http.post().uri(gateway.url(createWallet));\n",
    "app.yml": "forge-remote:\n  uris:\n    createWallet: /v1/wallets\n",
  };
  const linesOf = (p: string) => files[p]?.split("\n");
  const withY = [{ file: "app.yml", line: 3, value: "createWallet" }];
  const builds = (file: string, line: number) =>
    helperBuildsKey("forge-remote.uris.createWallet", { file, line, with: withY }, linesOf);

  it("is never cited on a document's prose", () => {
    expect(builds("README.md", 2)).toBe(false);
  });
  it("is never cited on a log message that only mentions the segment", () => {
    expect(builds("src/W.java", 1)).toBe(false);
  });
  it("is kept on code passing the segment as a whole literal, or as an identifier", () => {
    expect(builds("src/W.java", 2)).toBe(true);
    expect(builds("src/V.java", 1)).toBe(true);
  });

  const C = "c7c0001";
  const source = memory({
    "README.md": files["README.md"]!,
    "src/main/java/W.java": 'class W {\n  void f() { log.warn("createWallet failed"); }\n}\n',
    "src/main/resources/application.yml": files["app.yml"]!,
  });
  const call = (file: string, line: number) =>
    Fact.parse({
      kind: "call",
      id: "call.post.create",
      repo: "forge-wallets",
      commit: C,
      callType: "rest",
      method: "POST",
      path: "${forge-remote.uris.createWallet}",
      cite: {
        file,
        line,
        value: "createWallet",
        with: [{ file: "src/main/resources/application.yml", line: 3, value: "createWallet" }],
      },
      verified: "line",
      by: "assistant",
      conf: "declared",
    });
  it("is rejected by the verifier on a README line", async () => {
    const r = await verifyFacts({ facts: [call("README.md", 2)], source, commit: C });
    expect(r.rejected).toHaveLength(1);
  });
  it("is rejected by the verifier on a log line", async () => {
    const r = await verifyFacts({ facts: [call("src/main/java/W.java", 2)], source, commit: C });
    expect(r.rejected).toHaveLength(1);
  });
});

describe("a deploy tool's token, against its configuration", () => {
  it("is rejected when its env isn't the configuration's name", async () => {
    const fs = fixtureFacts()
      .filter((f) => f.id === "config.northwind-url-test")
      .map(
        (f) =>
          ({
            ...f,
            env: "prod",
            cite: {
              ...f.cite,
              with: [
                f.cite.with![0]!,
                f.cite.with![1]!,
                { file: "config.json", line: 19, value: "prod" },
              ],
            },
          }) as Fact,
      );
    const r = await verifyFacts({
      facts: fs,
      source: dirSource(join(FIX, "repos", R)),
      commit: "8888aaa",
    });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it("is rejected when its target isn't the file the token is under", async () => {
    const fs = fixtureFacts()
      .filter((f) => f.id === "config.northwind-url-prod")
      .map((f) => ({ ...f, target: "TE-Other.xml" }) as Fact);
    const r = await verifyFacts({
      facts: fs,
      source: dirSource(join(FIX, "repos", R)),
      commit: "8888aaa",
    });
    expect(r.rejected).toHaveLength(1);
  });

  it("keeps the fixture's tokens", async () => {
    const fs = fixtureFacts().filter((f) => f.kind === "config");
    const r = await verifyFacts({
      facts: fs,
      source: dirSource(join(FIX, "repos", R)),
      commit: "8888aaa",
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(2);
  });
});

describe("a deploy tool's token whose part carries the secret", () => {
  const X = "/AssignMessage/Set/Headers/Header[@name='x-api-key']";
  const FILES: Record<string, string> = {
    "config.json": [
      "{",
      '  "configurations": [',
      "    {",
      '      "name": "prod",',
      '      "policies": [',
      "        {",
      '          "name": "AM-Key.xml",',
      '          "tokens": [',
      "            {",
      `              "xpath": "${X}",`,
      '              "value": "q8Zt4LmN2vXy7RkP0sWd"',
      "            }",
      "          ]",
      "        }",
      "      ]",
      "    }",
      "  ]",
      "}",
    ].join("\n"),
    "apiproxy/policies/AM-Key.xml": "<AssignMessage/>",
  };
  it("is rejected on its own, never accepted", async () => {
    // As a reader that skipped the schema would hand it over: the schema refuses it too.
    const f = {
      kind: "config",
      id: "config.key",
      repo: "forge-wallets-proxy",
      commit: "abcdef1",
      settingKind: "config",
      key: X,
      target: "AM-Key.xml",
      env: "prod",
      cite: {
        file: "config.json",
        line: 10,
        value: "Header",
        with: [{ file: "config.json", line: 11, value: "q8Zt4LmN2vXy7RkP0sWd" }],
      },
      verified: "line",
      by: "assistant",
      conf: "declared",
    } as Fact;
    expect(Fact.safeParse(f).success).toBe(false);
    const r = await verifyFacts({ facts: [f], source: memory(FILES), commit: "abcdef1" });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(JSON.stringify(r.rejected)).not.toContain("q8Zt4LmN2vXy7RkP0sWd");
  });
});

describe("a token's config.json beside a gateway bundle", () => {
  const files = (bundle: string): Record<string, string> => ({
    "config.json":
      '{ "configurations": [ { "name": "prod", "targets": [ { "name": "default.xml", "tokens": [\n{ "xpath": "/TargetEndpoint/HTTPTargetConnection/URL", "value": "https://api.northwind.example/v1" }\n] } ] } ] }\n',
    [`${bundle}/targets/default.xml`]: "<TargetEndpoint/>",
  });
  const tokenFact = {
    kind: "config",
    id: "config.url",
    repo: "forge-shared",
    commit: "abcdef1",
    key: "/TargetEndpoint/HTTPTargetConnection/URL",
    value: "https://api.northwind.example/v1",
    cite: { file: "config.json", line: 2, value: "/TargetEndpoint/HTTPTargetConnection/URL" },
  };
  const linesOf = (fs: Record<string, string>) => (p: string) => fs[p]?.split("\n");

  it("is read beside a shared flow bundle (sharedflowbundle/)", () => {
    const fs = files("sharedflowbundle");
    expect(configLineProblem(tokenFact, linesOf(fs), () => Object.keys(fs))).toBeUndefined();
  });

  it("is read beside the bundle folders the org pack names", async () => {
    const fs = files("proxybundle");
    expect(
      configLineProblem(tokenFact, linesOf(fs), () => Object.keys(fs), ["proxybundle"]),
    ).toBeUndefined();
    expect(configLineProblem(tokenFact, linesOf(fs), () => Object.keys(fs))).toBeDefined();
    const r = await verifyFacts({
      facts: [Fact.parse(tokenFact)],
      source: memory(fs),
      commit: "abcdef1",
      conventions: { ...DEFAULT_CONVENTIONS, gatewayBundleFolders: ["proxybundle"] },
    });
    expect(r.rejected).toEqual([]);
  });
});
