import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APIGEE_BUNDLE,
  Conventions,
  DEFAULT_CONVENTIONS,
  FACING_WORDS,
  joinConventions,
  joinFacts,
  loadOrgPack,
  orgPackJsonSchemas,
  parseFacts,
  underFolders,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * ADR 0147: org-pack/conventions.yaml, the house conventions a read leans on. Optional; its
 * defaults are the lists Atticus had in code, so a pack without it reads as before, and a key
 * given replaces its list.
 */

describe("conventions.yaml (ADR 0147)", () => {
  it("defaults to the lists Atticus had in code", () => {
    expect(DEFAULT_CONVENTIONS).toEqual({
      // ADR 0163: version 2 adds org-wide notes; a version-1 file reads as version 2.
      schemaVersion: 2,
      apiSpecFolders: [
        "oas",
        "openapi",
        "swagger",
        "asyncapi",
        "api-spec",
        "api-specs",
        "apispec",
        "apispecs",
      ],
      gatewayBundleFolders: ["apiproxy", "sharedflowbundle"],
      facing: {
        internal: ["internal", "private", "intranet", "inside"],
        external: ["external", "partner", "public", "internet", "egress"],
      },
      frameworks: [],
      notProductFolders: [
        "src/test",
        "src/it",
        "test",
        "tests",
        "__tests__",
        "__mocks__",
        "spec",
        "specs",
        "e2e",
        "testdata",
        "test-data",
        "fixtures",
      ],
      notReadFolders: [
        "generated",
        "generated-sources",
        "__generated__",
        "gen",
        "dist",
        "build",
        "out",
        "target",
        "bin",
        "obj",
        "node_modules",
        "vendor",
        "vendored",
        "third_party",
        "third-party",
        ".next",
        ".nuxt",
        "coverage",
      ],
      housePrefixes: [],
    });
    expect(FACING_WORDS).toEqual(DEFAULT_CONVENTIONS.facing);
    expect(APIGEE_BUNDLE.test("proxies/x/apiproxy/proxies/default.xml")).toBe(true);
    expect(APIGEE_BUNDLE.test("proxies/x/APIPROXY/proxies/default.xml")).toBe(false);
  });

  it("replaces a list given, and keeps the rest", () => {
    const c = Conventions.parse({
      schemaVersion: 1,
      apiSpecFolders: ["contracts"],
      facing: { internal: ["corp"] },
      housePrefixes: ["com.forge.", "@forge/"],
      frameworks: [
        { declares: "forge-web-starter", name: "forge-web", topic: "spring", shape: "rest" },
      ],
    });
    expect(c.apiSpecFolders).toEqual(["contracts"]);
    expect(c.facing).toEqual({ internal: ["corp"], external: DEFAULT_CONVENTIONS.facing.external });
    expect(c.notReadFolders).toEqual(DEFAULT_CONVENTIONS.notReadFolders);
    expect(c.housePrefixes).toEqual(["com.forge.", "@forge/"]);
  });

  it("refuses a glob or an absolute folder, an unknown key and another version", () => {
    expect(
      Conventions.safeParse({ schemaVersion: 1, notProductFolders: ["**/test"] }).success,
    ).toBe(false);
    expect(Conventions.safeParse({ schemaVersion: 1, notReadFolders: ["/dist"] }).success).toBe(
      false,
    );
    expect(Conventions.safeParse({ schemaVersion: 1, notReadFolders: ["../x"] }).success).toBe(
      false,
    );
    expect(Conventions.safeParse({ schemaVersion: 1, readEverything: true }).success).toBe(false);
    expect(Conventions.safeParse({ schemaVersion: 3 }).success).toBe(false);
    expect(
      Conventions.safeParse({ schemaVersion: 1, frameworks: [{ declares: "a b", name: "x" }] })
        .success,
    ).toBe(false);
  });

  it("matches folders as whole segments anywhere in a path", () => {
    const re = underFolders(["src/test", "dist"]);
    expect(re.test("svc/src/test/Foo.java")).toBe(true);
    expect(re.test("dist/app.js")).toBe(true);
    expect(re.test("distro/app.js")).toBe(false);
    expect(underFolders([]).test("anything/at/all")).toBe(false);
  });

  it("loads from the org pack: the defaults without the file, a problem when it doesn't read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-conventions-"));
    const none = await loadOrgPack(dir);
    expect(none.conventions).toEqual(DEFAULT_CONVENTIONS);
    expect(none.defaulted).not.toContain("conventions.yaml");
    await writeFile(
      join(dir, "conventions.yaml"),
      "schemaVersion: 1\nhousePrefixes: [com.forge.]\ngatewayBundleFolders: [proxy-bundles]\n",
    );
    const some = await loadOrgPack(dir);
    expect(some.conventions?.housePrefixes).toEqual(["com.forge."]);
    expect(joinConventions(some).bundleFolders).toEqual(["proxy-bundles"]);
    await writeFile(join(dir, "conventions.yaml"), "schemaVersion: 1\nhousePrefixes: 7\n");
    const bad = await loadOrgPack(dir);
    expect(bad.conventions).toEqual(DEFAULT_CONVENTIONS);
    expect(bad.problems.map((p) => p.file)).toContain("conventions.yaml");
  });

  it("has a JSON Schema beside the other org-pack files", () => {
    expect(orgPackJsonSchemas()).toHaveProperty("Conventions");
  });
});

describe("the join reads the bundle folders and facing words from the conventions", () => {
  const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
  const read = (repo: string, move?: (f: string) => string): Fact[] => {
    const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return move
      ? r.facts.map((f) => ({ ...f, cite: { ...f.cite, file: move(f.cite.file) } }))
      : r.facts;
  };
  /** The gateway not typed one in the manifest: only its bundle folder says its entries are routes. */
  const estate = (move?: (f: string) => string): JoinRepo[] => [
    { repo: "forge-portal-api", facts: read("forge-portal-api"), component: "portal-api" },
    {
      repo: "forge-gateway",
      facts: read("forge-gateway", move),
      component: "api-gateway",
      hosts: ["api.forge.example"],
    },
    {
      repo: "forge-accounts",
      facts: read("forge-accounts"),
      component: "accounts-api",
      hosts: ["accounts.forge.internal"],
    },
  ];
  const through = (j: ReturnType<typeof joinFacts>) =>
    j.joins.filter((x) => x.gateway?.length).length;
  const moved = (f: string) => f.replace("/apiproxy/", "/proxy-bundles/");

  it("follows a bundle in a folder the organisation names, and not one it doesn't", () => {
    expect(through(joinFacts({ repos: estate() }))).toBeGreaterThan(0);
    expect(through(joinFacts({ repos: estate(moved) }))).toBe(0);
    expect(through(joinFacts({ repos: estate(moved), bundleFolders: ["proxy-bundles"] }))).toBe(
      through(joinFacts({ repos: estate() })),
    );
    expect(through(joinFacts({ repos: estate(), bundleFolders: ["proxy-bundles"] }))).toBe(0);
  });
});
