import { describe, expect, it } from "vitest";
import { Fact } from "@maycombhq/core";
import { verifyFacts, type FileSource } from "../src/index.js";

/**
 * Beta.28.1: a settings line whose value is a deploy token (`@NAME@`, filled in when the build
 * copies its resources; `${NAME}` or `${NAME:default}`, filled in when the app starts) sets the
 * token, not the value it resolves to. The token is always a value its line sets; a resolved
 * value is kept only when one of the fact's `with` lines sets NAME to exactly that value (a
 * build file's `<NAME>value</NAME>` property, a `NAME: value` or `NAME=value` line); a
 * placeholder's default is on the line itself. Otherwise the fact is refused, saying how to fix
 * it.
 */

const C = "c7c2811";
const Y = "src/main/resources/application.yml";
const P = "src/main/resources/application.properties";
const POM = "pom.xml";
const ENV = "deploy/prod.env";
const CI = "ci/deploy.yml";
const MVN = "ci/release.sh";
const BUNDLE = "gateway/config.json";
const VALUES = "deploy/values.yml";
const ENV2 = "deploy/staging.env";
const MVN2 = "ci/build.sh";
const TEST_RES = "src/test/resources/test.env";
const SECRET = "deploy/secrets/prod.env";
const BUNDLE2 = "gateway2/config.json";
const FILES: Record<string, string> = {
  [Y]: [
    "forge-ledger:", // 1
    "  datasource:", // 2
    "    default_schema: '@FORGE_SCHEMA@'", // 3
    "    region: ${LEDGER_REGION:north-1}", // 4
    "    pool: ${LEDGER_POOL}", // 5
    '    owner: "@FORGE_SCHEMA_OWNER@"', // 6
    "    size: ${ledger.pool}", // 7
  ].join("\n"),
  [P]: ["forge-ledger.datasource.default_schema=@FORGE_SCHEMA@"].join("\n"),
  [POM]: [
    "<project>", // 1
    "  <properties>", // 2
    "    <FORGE_SCHEMA>ledger_core</FORGE_SCHEMA>", // 3
    "    <FORGE_AUDIT_SCHEMA>ledger_audit</FORGE_AUDIT_SCHEMA>", // 4
    "  </properties>", // 5
    "</project>", // 6
  ].join("\n"),
  [ENV]: ["LEDGER_POOL=12", "FORGE_SCHEMA_OWNER=northwind_ops"].join("\n"),
  [CI]: ["variables:", "  LEDGER_POOL: 24"].join("\n"),
  [MVN]: ["mvn -B package -DFORGE_SCHEMA=ledger_release"].join("\n"),
  // The review of beta.28.1 (S1-S3): where a `with` line may set a token.
  [VALUES]: [
    "other:", // 1
    "  LEDGER_POOL: 99", // 2
    "LEDGER_POOL: 31", // 3
    "ledger:", // 4
    "  pool: 5", // 5
    "  extra:", // 6
    "    pool: 77", // 7
  ].join("\n"),
  [ENV2]: ["  LEDGER_POOL=44", "export LEDGER_POOL=45"].join("\n"),
  [MVN2]: [
    "mvn -DFORGE_SCHEMA=ledger_release -B package",
    "mvn -DFORGE_SCHEMA='ledger release' -B package",
  ].join("\n"),
  [TEST_RES]: ["LEDGER_POOL=13"].join("\n"),
  [SECRET]: ["LEDGER_POOL=14"].join("\n"),
  [BUNDLE2]: [
    "{", // 1
    '  "name": "@FORGE_SCHEMA@",', // 2
    '  "value": "ledger_top",', // 3
    '  "nested": { "name": "inner", "value": "ledger_nested" }', // 4
    "}", // 5
  ].join("\n"),
  [BUNDLE]: [
    "{", // 1
    '  "configurations": [', // 2
    "    {", // 3
    '      "name": "prod",', // 4
    '      "policies": [', // 5
    '        { "name": "@FORGE_SCHEMA@",', // 6
    '          "value": "ledger_gateway" }', // 7
    "      ]", // 8
    "    }", // 9
    "  ]", // 10
    "}", // 11
  ].join("\n"),
};
const source: FileSource = { list: () => Object.keys(FILES), read: (p) => FILES[p] };
const lineOf = (file: string, line: number) => FILES[file]!.split("\n")[line - 1]!;
const part = (file: string, line: number, value: string) => ({ file, line, value });
const cfg = (
  id: string,
  key: string,
  value: string,
  file: string,
  line: number,
  extra: Record<string, unknown> = {},
) =>
  Fact.parse({
    kind: "config",
    id,
    repo: "forge-ledger",
    commit: C,
    key,
    value,
    cite: {
      file,
      line,
      value: key.split(".").pop(),
      quote: lineOf(file, line),
      ...extra,
    },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const run = async (f: Fact) => {
  const r = await verifyFacts({ facts: [f], source, commit: C });
  return r.rejected.map((x) => ({ code: x.code, message: x.message }));
};
const KEY = "forge-ledger.datasource.default_schema";

describe("a deploy token's value is verified where it is set", () => {
  it("keeps the token claimed as written, with or without its quotes", async () => {
    expect(await run(cfg("config.tok", KEY, "@FORGE_SCHEMA@", Y, 3))).toEqual([]);
    expect(await run(cfg("config.tok-q", KEY, "'@FORGE_SCHEMA@'", Y, 3))).toEqual([]);
    expect(await run(cfg("config.tok-p", KEY, "@FORGE_SCHEMA@", P, 1))).toEqual([]);
    expect(
      await run(cfg("config.ph", "forge-ledger.datasource.pool", "${LEDGER_POOL}", Y, 5)),
    ).toEqual([]);
  });

  it("keeps a resolved value whose `with` line is a build property setting it", async () => {
    expect(
      await run(
        cfg("config.res", KEY, "ledger_core", Y, 3, { with: [part(POM, 3, "ledger_core")] }),
      ),
    ).toEqual([]);
    expect(
      await run(
        cfg("config.res-p", KEY, "ledger_core", P, 1, { with: [part(POM, 3, "ledger_core")] }),
      ),
    ).toEqual([]);
  });

  it("keeps a resolved value set by a NAME=value or NAME: value line", async () => {
    expect(
      await run(
        cfg("config.env", "forge-ledger.datasource.pool", "12", Y, 5, {
          with: [part(ENV, 1, "12")],
        }),
      ),
    ).toEqual([]);
    expect(
      await run(
        cfg("config.ci", "forge-ledger.datasource.pool", "24", Y, 5, {
          with: [part(CI, 2, "24")],
        }),
      ),
    ).toEqual([]);
    expect(
      await run(
        cfg("config.owner", "forge-ledger.datasource.owner", "northwind_ops", Y, 6, {
          with: [part(ENV, 2, "northwind_ops")],
        }),
      ),
    ).toEqual([]);
  });

  it("keeps a placeholder's default claimed: the default is on the line", async () => {
    expect(await run(cfg("config.def", "forge-ledger.datasource.region", "north-1", Y, 4))).toEqual(
      [],
    );
  });

  it("rejects a resolved value with no `with` line setting it, saying how to fix it", async () => {
    const r = await run(cfg("config.bare", KEY, "ledger_core", Y, 3));
    expect(r.map((x) => x.code)).toEqual(["claim-not-on-line"]);
    expect(r[0]!.message).toContain(
      `${Y}:3 sets default_schema to the token @FORGE_SCHEMA@; claim the token, or cite where @FORGE_SCHEMA@ is set in \`with\``,
    );
    const p = await run(cfg("config.bare-p", KEY, "ledger_core", P, 1));
    expect(p.map((x) => x.code)).toEqual(["claim-not-on-line"]);
    expect(p[0]!.message).toContain("to the token @FORGE_SCHEMA@; claim the token");
  });

  it("rejects a resolved value whose `with` line sets another name or another value", async () => {
    // the property line sets FORGE_AUDIT_SCHEMA, not FORGE_SCHEMA
    expect(
      (
        await run(
          cfg("config.other", KEY, "ledger_audit", Y, 3, { with: [part(POM, 4, "ledger_audit")] }),
        )
      ).map((x) => x.code),
    ).toContain("claim-not-on-line");
    // the env line sets LEDGER_POOL to 12, not 99
    expect(
      (
        await run(
          cfg("config.wrong", "forge-ledger.datasource.pool", "99", Y, 5, {
            with: [part(ENV, 1, "12")],
          }),
        )
      ).map((x) => x.code),
    ).toContain("claim-not-on-line");
    // a placeholder's default is the only resolved value its line sets
    expect(
      (await run(cfg("config.def-bad", "forge-ledger.datasource.region", "south-9", Y, 4))).map(
        (x) => x.code,
      ),
    ).toEqual(["claim-not-on-line"]);
  });

  it("keeps a resolved value set by a -D build flag or a deploy config.json token of that name", async () => {
    expect(
      await run(
        cfg("config.mvn", KEY, "ledger_release", Y, 3, { with: [part(MVN, 1, "ledger_release")] }),
      ),
    ).toEqual([]);
    expect(
      await run(
        cfg("config.bundle", KEY, "ledger_gateway", Y, 3, {
          with: [part(BUNDLE, 7, "ledger_gateway")],
        }),
      ),
    ).toEqual([]);
    // the token object sets ledger_gateway, not ledger_core
    expect(
      (
        await run(
          cfg("config.bundle-bad", KEY, "ledger_core", Y, 3, {
            with: [part(BUNDLE, 7, "ledger_gateway")],
          }),
        )
      ).map((x) => x.code),
    ).toEqual(["claim-not-on-line"]);
  });
});

describe("where a `with` line may set a token (the review of beta.28.1)", () => {
  const codes = async (f: Fact) => (await run(f)).map((x) => x.code);
  it("S1: in YAML the key's whole dotted path names the token; a key nested under another parent doesn't", async () => {
    const pool = (line: number, value: string) =>
      cfg(`config.v${line}`, "forge-ledger.datasource.pool", value, Y, 5, {
        with: [part(VALUES, line, value)],
      });
    expect(await codes(pool(2, "99"))).toEqual(["claim-not-on-line"]);
    expect(await codes(pool(3, "31"))).toEqual([]);
    const size = (line: number, value: string) =>
      cfg(`config.s${line}`, "forge-ledger.datasource.size", value, Y, 7, {
        with: [part(VALUES, line, value)],
      });
    expect(await codes(size(5, "5"))).toEqual([]);
    expect(await codes(size(7, "77"))).toEqual(["claim-not-on-line"]);
    // A CI file's variables block still sets it (ci/deploy.yml: `variables:` then `LEDGER_POOL: 24`).
    expect(
      await codes(
        cfg("config.ci2", "forge-ledger.datasource.pool", "24", Y, 5, {
          with: [part(CI, 2, "24")],
        }),
      ),
    ).toEqual([]);
  });
  it("S1: outside YAML a NAME= line sets it only from its start (`export` allowed)", async () => {
    const pool = (line: number, value: string) =>
      cfg(`config.e${line}`, "forge-ledger.datasource.pool", value, Y, 5, {
        with: [part(ENV2, line, value)],
      });
    expect(await codes(pool(1, "44"))).toEqual(["claim-not-on-line"]);
    expect(await codes(pool(2, "45"))).toEqual([]);
  });
  it("S2: a -D flag's value is one shell word, quoted or not, with more flags after it", async () => {
    expect(
      await codes(
        cfg("config.m1", KEY, "ledger_release", Y, 3, { with: [part(MVN2, 1, "ledger_release")] }),
      ),
    ).toEqual([]);
    expect(
      await codes(
        cfg("config.m2", KEY, "ledger release", Y, 3, { with: [part(MVN2, 2, "ledger release")] }),
      ),
    ).toEqual([]);
    expect(
      await codes(
        cfg("config.m3", KEY, "ledger_release -B package", Y, 3, {
          with: [part(MVN2, 1, "ledger_release -B package")],
        }),
      ),
    ).toEqual(["claim-not-on-line"]);
  });
  it("S3: a test's resources or a secret file never set a token", async () => {
    const pool = (file: string, value: string) =>
      cfg(`config.${value}`, "forge-ledger.datasource.pool", value, Y, 5, {
        with: [part(file, 1, value)],
      });
    expect(await codes(pool(TEST_RES, "13"))).toEqual(["claim-not-on-line"]);
    // A secret file isn't read at all (verify refuses citing it); the token isn't set by it.
    expect((await run(pool(SECRET, "14"))).length).toBeGreaterThan(0);
  });
  it("a config.json token's value is the object's own, not a nested object's", async () => {
    const at = (line: number, value: string) =>
      cfg(`config.b${line}`, KEY, value, Y, 3, { with: [part(BUNDLE2, line, value)] });
    expect(await codes(at(3, "ledger_top"))).toEqual([]);
    expect(await codes(at(4, "ledger_nested"))).toEqual(["claim-not-on-line"]);
    // Cited on the token object's own line, a nested object's value still isn't its own.
    expect(
      await codes(
        cfg("config.b2n", KEY, "ledger_nested", Y, 3, {
          with: [part(BUNDLE2, 2, "ledger_nested")],
        }),
      ),
    ).toEqual(["claim-not-on-line"]);
  });
});
