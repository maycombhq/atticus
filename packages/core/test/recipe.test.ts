import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  Fact,
  parseFacts,
  proveRecipe,
  ReadingRulesFile,
  runRecipe,
  type ReadingRule,
  type RecipeFile,
} from "../src/index.js";

/**
 * ADR 0210 part 2: the recipe engine, on the invented `fixtures/gateway-shape` (two integration
 * modules on one context path). The recipe is `org-pack/reading-rules/types/integration-module.yaml`;
 * each module's hand-written facts are `facts/<repo>.jsonl`; the engine's output on the ledger
 * module is `expected/recipe-ledger.yaml`, checked by hand against the module's file.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-shape");
const WALLETS = "forge-wallets-module";
const LEDGER = "forge-ledger-module";
const XML = "src/main/resources/OSGI-INF/blueprint/camel-context.xml";

const filesOf = (repo: string): RecipeFile[] => {
  const root = join(FIX, "repos", repo);
  const out: RecipeFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
};
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const rules = (): ReadingRule[] =>
  ReadingRulesFile.parse(
    parse(
      readFileSync(
        join(FIX, "org-pack", "reading-rules", "types", "integration-module.yaml"),
        "utf8",
      ),
    ),
  ).rules;
const rule = (key: string) => rules().find((r) => r.key === key)!;
const golden = (name: string, got: unknown) => {
  // UPDATE_GOLDEN=1 writes what the engine gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN) writeFileSync(join(FIX, "expected", name), stringify(got));
  return parse(readFileSync(join(FIX, "expected", name), "utf8")) as unknown;
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const at = (repo: string, commit: string) => ({ repo, commit });

describe("runRecipe (ADR 0210 part 2)", () => {
  it("reads the module it wasn't written from as its golden file says, every fact valid", () => {
    const got = runRecipe(rule("blueprint-rest-entries"), filesOf(LEDGER), at(LEDGER, "5d6e7f8"));
    expect(plain(got)).toEqual(golden("recipe-ledger.yaml", plain(got)));
    for (const f of got) expect(Fact.safeParse(f).success).toBe(true);
    expect(got.map((f) => (f.kind === "entry" ? `${f.method} ${f.path}` : ""))).toEqual([
      "GET /cxf/api/accounts/{accountId}",
      "GET /cxf/api/accounts/{accountId}/blocks",
      "GET /cxf/api/statements/{statementId}",
    ]);
  });

  it("cites the line with a value on it, and each scope it used in with", () => {
    const files = filesOf(WALLETS);
    const lines = files.find((f) => f.path === XML)!.text.split("\n");
    const got = runRecipe(rule("blueprint-rest-entries"), files, at(WALLETS, "1a2b3c4"));
    expect(got.map((f) => f.cite.line)).toEqual([6, 9, 12, 15]);
    for (const f of got) {
      expect(lines[f.cite.line - 1]).toContain(f.cite.value);
      expect(f.by).toBe("reader");
      expect(f.conf).toBe("declared");
      expect(f.commit).toBe("1a2b3c4");
      for (const w of f.cite.with ?? []) expect(lines[w.line - 1]).toContain(w.value);
    }
    // `<post>` has no uri (optional): the fact is kept, its value the verb as written.
    const post = got[1]!;
    expect(post.kind === "entry" && [post.method, post.path, post.cite.value]).toEqual([
      "POST",
      "/cxf/api/accounts",
      "post",
    ]);
    expect(post.cite.with).toEqual([
      { file: XML, line: 4, value: "/cxf/api" },
      { file: XML, line: 5, value: "/accounts" },
    ]);
  });

  it("drops a fact whose named group or scope didn't match, unless it is optional", () => {
    const r = rule("blueprint-rest-entries");
    const text =
      '<get uri="/a">\n<rest path="/r">\n<get uri="/b">\n</rest>\n<get uri="/c">\n<post>\n';
    const got = runRecipe(r, [{ path: XML, text }], at(WALLETS, "1a2b3c4"));
    // No context anywhere: every fact drops.
    expect(got).toEqual([]);
    const opt = { ...r, extract: { ...r.extract!, optional: ["uri", "context"] } } as ReadingRule;
    const kept = runRecipe(opt, [{ path: XML, text }], at(WALLETS, "1a2b3c4"));
    // The rest scope holds from line 2 until `</rest>` on line 4; outside it the fact drops.
    expect(kept.map((f) => [f.cite.line, f.kind === "entry" && f.path])).toEqual([[3, "/r/b"]]);
  });

  it("doesn't match a line over 2,000 characters, and reads only the files the rule names", () => {
    const r = rule("blueprint-rest-entries");
    const head = '<restConfiguration contextPath="/x"/>\n<rest path="/r">\n';
    const long = `<get uri="/${"a".repeat(2000)}">\n<get uri="/ok">\n`;
    const got = runRecipe(r, [{ path: XML, text: head + long }], at(WALLETS, "1a2b3c4"));
    expect(got.map((f) => f.cite.line)).toEqual([4]);
    expect(
      runRecipe(r, [{ path: "other.xml", text: head + long }], at(WALLETS, "1a2b3c4")),
    ).toEqual([]);
  });

  it("orders facts by file then line, and the same input gives the same ids", () => {
    const r = rule("blueprint-rest-entries");
    const t = '<restConfiguration contextPath="/x"/>\n<rest path="/r">\n<get uri="/a">\n';
    const dir = "src/main/resources/OSGI-INF/blueprint/";
    const files = [
      { path: `${dir}b.xml`, text: t },
      { path: `${dir}a.xml`, text: t },
    ];
    const one = runRecipe(r, files, at(WALLETS, "1a2b3c4"));
    expect(one.map((f) => f.cite.file)).toEqual([`${dir}a.xml`, `${dir}b.xml`]);
    expect(runRecipe(r, [...files].reverse(), at(WALLETS, "1a2b3c4"))).toEqual(one);
    expect(new Set(one.map((f) => f.id)).size).toBe(2);
  });

  it("yaml leaves: one fact per scalar leaf, its dotted key, each parent key cited", () => {
    const text = [
      "service: forge-ledger-module # its name",
      "server:",
      "  tls:",
      "    port: 8443",
      "  # a comment",
      "  host: ledger.forge.example",
      "list:",
      "  - one",
      "",
    ].join("\n");
    const got = runRecipe(
      rule("deploy-settings"),
      [{ path: "deploy/prod.yaml", text }],
      at(LEDGER, "5d6e7f8"),
    );
    expect(
      got.map(
        (f) => f.kind === "config" && [f.cite.line, f.key, f.value, f.cite.value, f.cite.with],
      ),
    ).toEqual([
      [1, "service", "forge-ledger-module", "service", undefined],
      [
        4,
        "server.tls.port",
        "8443",
        "port",
        [
          { file: "deploy/prod.yaml", line: 2, value: "server" },
          { file: "deploy/prod.yaml", line: 3, value: "tls" },
        ],
      ],
      [
        6,
        "server.host",
        "ledger.forge.example",
        "host",
        [{ file: "deploy/prod.yaml", line: 2, value: "server" }],
      ],
    ]);
    // The fixture's deploy files read too.
    expect(runRecipe(rule("deploy-settings"), filesOf(LEDGER), at(LEDGER, "5d6e7f8")).length).toBe(
      6,
    );
  });
});

describe("proveRecipe (ADR 0210 part 2, ADR 0208's proof)", () => {
  const reads = () => [
    { repo: WALLETS, files: filesOf(WALLETS), facts: factsOf(WALLETS) },
    { repo: LEDGER, files: filesOf(LEDGER), facts: factsOf(LEDGER) },
  ];

  it("matches each module's hand-written facts, and proves only on two repos it wasn't written from", () => {
    const r = rule("blueprint-rest-entries");
    const two = proveRecipe(r, reads());
    expect(two.repos.map((x) => [x.repo, x.same, x.differ.length])).toEqual([
      [WALLETS, true, 0],
      [LEDGER, true, 0],
    ]);
    expect(two.proof).toEqual({
      repos: [WALLETS, LEDGER],
      reread: [`${WALLETS} ${XML}`, `${LEDGER} ${XML}`],
      reproduced: [6, 9, 12, 15]
        .map((l) => `${WALLETS} ${XML}:${l}`)
        .concat([6, 9, 14].map((l) => `${LEDGER} ${XML}:${l}`)),
    });
    // Written from the wallets module: only one repo left, so no proof; the rule stays a draft.
    expect(proveRecipe(r, reads(), { writtenFrom: [WALLETS] }).proof).toBeUndefined();
    // The proof it gives makes the rule valid as active.
    expect(
      ReadingRulesFile.safeParse({
        schemaVersion: 3,
        rules: [
          {
            ...r,
            status: "active",
            learned: {
              corrections: [],
              by: "recipe",
              at: "2026-11-24T10:00:00.000Z",
              proof: two.proof,
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("a missing scope part fails the proof, saying which facts differ (item 0: the small model's recipe)", () => {
    const r = rule("blueprint-rest-entries");
    const small = {
      ...r,
      extract: {
        ...r.extract!,
        scopes: [(r.extract as { scopes: unknown[] }).scopes[0]],
        fields: { method: "{verb}", path: "{context}{uri}" },
      },
    } as ReadingRule;
    const got = proveRecipe(small, reads());
    expect(got.proof).toBeUndefined();
    expect(got.repos.map((x) => x.same)).toEqual([false, false]);
    expect(got.repos[1]!.differ).toEqual([
      {
        file: XML,
        line: 6,
        field: "path",
        want: "/cxf/api/accounts/{accountId}",
        got: "/cxf/api/{accountId}",
      },
      {
        file: XML,
        line: 9,
        field: "path",
        want: "/cxf/api/accounts/{accountId}/blocks",
        got: "/cxf/api/{accountId}/blocks",
      },
      {
        file: XML,
        line: 14,
        field: "path",
        want: "/cxf/api/statements/{statementId}",
        got: "/cxf/api/{statementId}",
      },
    ]);
  });

  it("a fact the read has and the recipe doesn't, or the other way, is a difference", () => {
    const r = rule("blueprint-rest-entries");
    const [w] = reads();
    const missing = proveRecipe(r, [{ ...w!, facts: w!.facts.slice(1) }]).repos[0]!;
    expect(missing.same).toBe(false);
    expect(missing.extra).toEqual([{ file: XML, line: 6 }]);
    const extra = proveRecipe(r, [{ ...w!, files: [] }]).repos[0]!;
    expect(extra.missing.map((m) => m.line)).toEqual([6, 9, 12, 15]);
    // A repo with nothing read and nothing found proves nothing.
    expect(proveRecipe(r, [{ ...w!, files: [], facts: [] }]).repos[0]!.same).toBe(false);
  });
});
