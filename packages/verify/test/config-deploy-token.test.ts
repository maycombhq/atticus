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
const FILES: Record<string, string> = {
  [Y]: [
    "forge-ledger:", // 1
    "  datasource:", // 2
    "    default_schema: '@DEFAULT_SCHEMA@'", // 3
    "    region: ${LEDGER_REGION:north-1}", // 4
    "    pool: ${LEDGER_POOL}", // 5
    "    owner: \"@SCHEMA_OWNER@\"", // 6
  ].join("\n"),
  [P]: ["forge-ledger.datasource.default_schema=@DEFAULT_SCHEMA@"].join("\n"),
  [POM]: [
    "<project>", // 1
    "  <properties>", // 2
    "    <DEFAULT_SCHEMA>ledger_core</DEFAULT_SCHEMA>", // 3
    "    <OTHER_SCHEMA>ledger_audit</OTHER_SCHEMA>", // 4
    "  </properties>", // 5
    "</project>", // 6
  ].join("\n"),
  [ENV]: ["LEDGER_POOL=12", "SCHEMA_OWNER=northwind_ops"].join("\n"),
  [CI]: ["variables:", "  LEDGER_POOL: 24"].join("\n"),
};
const source: FileSource = { list: () => Object.keys(FILES), read: (p) => FILES[p] };
const lineOf = (file: string, line: number) => FILES[file]!.split("\n")[line - 1]!;
const part = (file: string, line: number, value: string) => ({
  file,
  line,
  value,
  quote: lineOf(file, line),
});
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
    expect(await run(cfg("config.tok", KEY, "@DEFAULT_SCHEMA@", Y, 3))).toEqual([]);
    expect(await run(cfg("config.tok-q", KEY, "'@DEFAULT_SCHEMA@'", Y, 3))).toEqual([]);
    expect(await run(cfg("config.tok-p", KEY, "@DEFAULT_SCHEMA@", P, 1))).toEqual([]);
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
    expect(
      await run(cfg("config.def", "forge-ledger.datasource.region", "north-1", Y, 4)),
    ).toEqual([]);
  });

  it("rejects a resolved value with no `with` line setting it, saying how to fix it", async () => {
    const r = await run(cfg("config.bare", KEY, "ledger_core", Y, 3));
    expect(r.map((x) => x.code)).toEqual(["claim-not-on-line"]);
    expect(r[0]!.message).toContain(
      `${Y}:3 sets default_schema to the token @DEFAULT_SCHEMA@; claim the token, or cite where @DEFAULT_SCHEMA@ is set in \`with\``,
    );
    const p = await run(cfg("config.bare-p", KEY, "ledger_core", P, 1));
    expect(p.map((x) => x.code)).toEqual(["claim-not-on-line"]);
    expect(p[0]!.message).toContain("to the token @DEFAULT_SCHEMA@; claim the token");
  });

  it("rejects a resolved value whose `with` line sets another name or another value", async () => {
    // the property line sets OTHER_SCHEMA, not DEFAULT_SCHEMA
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
});
