import { describe, expect, it } from "vitest";
import { migrateReadingRulesText, ReadingRulesFile } from "../src/index.js";

/** ADR 0208: reading rules version 2, a rule's `learned` and its proof, and the migration. */

const RULE = {
  key: "path-from-constant",
  rule: "A call's path is the value of the constant its field is set from.",
  files: ["src/main/java/**/*Client.java"],
};
const LEARNED = {
  corrections: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"],
  by: "pat",
  at: "2026-11-08T10:15:00.000Z",
};
const PROOF = {
  repos: ["forge-billing"],
  reread: ["forge-billing src/main/java/forge/billing/PartnerClient.java"],
  reproduced: LEARNED.corrections,
};

describe("reading rules version 2 (ADR 0208)", () => {
  it("reads a version 1 file as it did", () => {
    expect(ReadingRulesFile.safeParse({ schemaVersion: 1, rules: [RULE] }).success).toBe(true);
  });

  it("takes learned only at version 2, and a learned rule is active only with its proof", () => {
    const at = (v: number, r: object) =>
      ReadingRulesFile.safeParse({ schemaVersion: v, rules: [{ ...RULE, ...r }] });
    expect(at(1, { status: "draft", learned: { ...LEARNED, why: "it didn't" } }).success).toBe(
      false,
    );
    expect(at(2, { status: "draft", learned: { ...LEARNED, why: "it didn't" } }).success).toBe(
      true,
    );
    expect(at(2, { status: "active", learned: LEARNED }).success).toBe(false);
    expect(at(2, { status: "active", learned: { ...LEARNED, proof: PROOF } }).success).toBe(true);
    // A proof names the repos it was proven on; a draft that names no correction says why.
    const { repos: _r, ...noRepos } = PROOF;
    expect(at(2, { status: "active", learned: { ...LEARNED, proof: noRepos } }).success).toBe(
      false,
    );
    expect(
      at(2, { status: "draft", learned: { ...LEARNED, corrections: [], why: "no files" } }).success,
    ).toBe(true);
  });

  it("migrates 1 to 2 by the number only, every other line as written", () => {
    const text = 'schemaVersion: 1 # ours\nrules:\n  - { key: a, rule: "ten letters at least" }\n';
    expect(migrateReadingRulesText(text)).toEqual({
      text: text.replace("schemaVersion: 1 # ours", "schemaVersion: 2 # ours"),
      changed: true,
    });
    // A quoted number too (a YAML string), as a hand might write it.
    expect(migrateReadingRulesText('schemaVersion: "1"\nrules: []\n').text).toBe(
      "schemaVersion: 2\nrules: []\n",
    );
    const two = text.replace("1 # ours", "2");
    expect(migrateReadingRulesText(two)).toEqual({ text: two, changed: false });
  });
});
