import { describe, expect, it } from "vitest";
import { migrateReadingRulesText, ReadingRulesFile } from "../src/index.js";

/** ADR 0210 part 2: reading rules version 3, a rule's `extract` (a recipe), and the migration. */

const EXTRACT = {
  fact: "entry",
  pattern: '<(?<verb>get|post|put|delete|patch)(?: uri="(?<uri>[^"]*)")?',
  scopes: [
    { name: "context", pattern: 'contextPath="(?<context>[^"]*)"' },
    { name: "rest", pattern: '<rest path="(?<rest>[^"]*)"', end: "</rest>" },
  ],
  optional: ["uri"],
  fields: { method: "{verb}", path: "{context}{rest}{uri}" },
};
const RULE = {
  key: "blueprint-rest-entries",
  status: "draft",
  rule: "Each verb element under a <rest> block is an entry.",
  files: ["src/main/resources/OSGI-INF/blueprint/*.xml"],
  extract: EXTRACT,
};
const PROOF = {
  repos: ["forge-wallets-module", "forge-ledger-module"],
  reread: [
    "forge-wallets-module src/main/resources/OSGI-INF/blueprint/camel-context.xml",
    "forge-ledger-module src/main/resources/OSGI-INF/blueprint/camel-context.xml",
  ],
  reproduced: ["forge-wallets-module src/main/resources/OSGI-INF/blueprint/camel-context.xml:6"],
};
const LEARNED = { corrections: [], by: "recipe", at: "2026-11-24T10:00:00.000Z" };

const at = (v: number, r: object) =>
  ReadingRulesFile.safeParse({ schemaVersion: v, rules: [{ ...RULE, ...r }] });
const withExtract = (e: object, r: object = {}) => at(3, { extract: { ...EXTRACT, ...e }, ...r });
const messages = (r: ReturnType<typeof at>) =>
  r.success ? [] : r.error.issues.map((i) => i.message);

describe("reading rules version 3 (ADR 0210 part 2)", () => {
  it("reads version 1 and 2 files as they did, and takes extract only at version 3", () => {
    const { extract: _e, ...plain } = RULE;
    expect(ReadingRulesFile.safeParse({ schemaVersion: 1, rules: [plain] }).success).toBe(true);
    expect(ReadingRulesFile.safeParse({ schemaVersion: 2, rules: [plain] }).success).toBe(true);
    expect(at(2, {}).success).toBe(false);
    expect(at(3, {}).success).toBe(true);
    expect(at(3, { extract: { fact: "config", yaml: "leaves" } }).success).toBe(true);
    expect(
      at(3, { extract: { fact: "config", yaml: "leaves", fields: { key: "{key}" } } }).success,
    ).toBe(true);
  });

  it("refuses a template with a literal part (item 0: the strong model's first recipe)", () => {
    const r = withExtract({ fields: { method: "{verb}", path: "{context}/accounts{uri}" } });
    expect(r.success).toBe(false);
    expect(messages(r).join(" ")).toMatch(/only \{group\} references/);
    // A constant is a literal too, and so are two separators or a separator at an end.
    expect(withExtract({ fields: { method: "GET", path: "{uri}" } }).success).toBe(false);
    expect(withExtract({ fields: { path: "{context}//{uri}" } }).success).toBe(false);
    expect(withExtract({ fields: { path: "/{uri}" } }).success).toBe(false);
    // One separator from / . : - _ between two references is a template.
    expect(withExtract({ fields: { method: "{verb}", path: "{context}/{uri}" } }).success).toBe(
      true,
    );
    expect(withExtract({ fields: { method: "{verb}", path: "{rest}.{uri}" } }).success).toBe(true);
  });

  it("refuses a template naming a group neither the pattern nor a scope has", () => {
    const r = withExtract({ fields: { method: "{verb}", path: "{context}{base}{uri}" } });
    expect(r.success).toBe(false);
    expect(messages(r).join(" ")).toMatch(/base/);
    // An optional name is one the template uses.
    expect(withExtract({ optional: ["nope"] }).success).toBe(false);
    // A scope's pattern captures the scope's own name.
    expect(withExtract({ scopes: [{ name: "context", pattern: "contextPath" }] }).success).toBe(
      false,
    );
  });

  it("refuses a field the fact kind doesn't have, and a pattern that doesn't compile", () => {
    expect(withExtract({ fields: { method: "{verb}", route: "{uri}" } }).success).toBe(false);
    expect(withExtract({ pattern: "<(?<verb>get" }).success).toBe(false);
    expect(withExtract({ fact: "nothing" }).success).toBe(false);
  });

  it("refuses a pattern RE2 can't run in linear time: a backreference or a lookaround", () => {
    for (const p of ["(?<verb>a)\\1", "(?=a)(?<verb>a)", "(?<verb>a)(?!b)", "(?<=x)(?<verb>a)"]) {
      const r = withExtract({ pattern: p, optional: [], fields: { path: "{verb}" } });
      expect(r.success, p).toBe(false);
      expect(messages(r).join(" ")).toMatch(/RE2/);
    }
    expect(
      withExtract({ scopes: [{ name: "context", pattern: "(?<context>a)\\1" }] }).success,
    ).toBe(false);
  });

  it("sets only a kind field (entryType, callType, settingKind, tableKind), never a claim", () => {
    expect(withExtract({ set: { entryType: "grpc" } }).success).toBe(true);
    const auth = withExtract({ set: { auth: "mtls" } });
    expect(auth.success).toBe(false);
    expect(messages(auth).join(" ")).toMatch(/set takes only/);
    expect(withExtract({ set: { entryType: "nothing" } }).success).toBe(false);
  });

  it("refuses a scope named like a group of the pattern", () => {
    const r = withExtract({
      scopes: [{ name: "uri", pattern: 'contextPath="(?<uri>[^"]*)"' }],
      fields: { method: "{verb}", path: "{uri}" },
    });
    expect(r.success).toBe(false);
    expect(messages(r).join(" ")).toMatch(/name of a group/);
  });

  it("refuses a value of more than six cited parts", () => {
    const scopes = ["a", "b", "c", "d", "e", "f", "g"].map((n) => ({
      name: n,
      pattern: `${n}="(?<${n}>[^"]*)"`,
    }));
    const path = scopes.map((s) => `{${s.name}}`).join("");
    expect(withExtract({ scopes, optional: [], fields: { path: `${path}{uri}` } }).success).toBe(
      false,
    );
    expect(
      withExtract({
        scopes: scopes.slice(0, 6),
        optional: [],
        fields: { path: `${path.slice(0, 18)}{uri}` },
      }).success,
    ).toBe(true);
  });

  it("an active recipe needs a proof naming two repos", () => {
    expect(at(3, { status: "active" }).success).toBe(false);
    expect(
      at(3, { status: "active", learned: { ...LEARNED, proof: { ...PROOF, repos: ["one"] } } })
        .success,
    ).toBe(false);
    expect(at(3, { status: "active", learned: { ...LEARNED, proof: PROOF } }).success).toBe(true);
    expect(
      at(3, { learned: { ...LEARNED, why: "forge-ledger-module: 3 facts differ" } }).success,
    ).toBe(true);
  });

  it("migrates 1 or 2 to 3 by the number only when asked; Learn's 1 to 2 is as it was", () => {
    const text = 'schemaVersion: 2 # ours\nrules:\n  - { key: a, rule: "ten letters at least" }\n';
    expect(migrateReadingRulesText(text, 3)).toEqual({
      text: text.replace("schemaVersion: 2 # ours", "schemaVersion: 3 # ours"),
      changed: true,
    });
    expect(migrateReadingRulesText("schemaVersion: '1'\nrules: []\n", 3).text).toBe(
      "schemaVersion: 3\nrules: []\n",
    );
    expect(migrateReadingRulesText(text)).toEqual({ text, changed: false });
    const three = text.replace("2 # ours", "3");
    expect(migrateReadingRulesText(three, 3)).toEqual({ text: three, changed: false });
    expect(migrateReadingRulesText(three)).toEqual({ text: three, changed: false });
  });
});
