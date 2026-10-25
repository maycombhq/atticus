import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FactCorrection, parseCorrections, parseFacts, type Fact } from "@maycombhq/core";
import { applyCorrections, dirSource, verifyFacts } from "../src/index.js";

/**
 * A person's corrections of a repo's facts, from the Map (ADR 0124 addendum D-app, F3):
 * `<repo>.corrections.jsonl`, applied by the verifier every time it runs. A fact marked wrong is
 * left out; an edited fact is a person's fact, still checked on its line.
 */

const fixtures = join(__dirname, "fixtures");
const repo = join(fixtures, "repo");
const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const corrections = () => {
  const r = parseCorrections(
    readFileSync(join(fixtures, "forge-ledger.corrections.jsonl"), "utf8"),
  );
  expect(r.bad).toEqual([]);
  return r.corrections;
};
const verify = (fs: Fact[], cs = corrections()) =>
  verifyFacts({ facts: fs, source: dirSource(repo), commit: "0123abc", corrections: cs });

describe("a person's corrections, applied by the verifier", () => {
  it("leaves a fact marked wrong out, keeps an edited one as the person's, and says which met nothing", async () => {
    const r = await verify(facts());
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((f) => f.id)).not.toContain("e-settle-listener");
    expect(r.accepted).toHaveLength(16);
    const get = r.accepted.find((f) => f.id === "e-get-account")!;
    expect(get).toMatchObject({
      handler: "AccountController.read",
      by: "person",
      verified: "person",
    });
    // The rest are the line check's, as before.
    expect(r.accepted.find((f) => f.id === "e-post-entry")!.verified).toBe("line");
    expect(r.corrections.applied).toEqual([
      { fact: "e-get-account", action: "edit", by: "Priya Nair <priya@forge.example>" },
      { fact: "e-settle-listener", action: "wrong", by: "Priya Nair <priya@forge.example>" },
    ]);
    // An edit that meets no fact is said; a fact marked wrong that isn't there is as it should be.
    expect(r.corrections.stale.map((s) => [s.correction.fact, s.why])).toEqual([
      ["e-gone", "none"],
    ]);
    expect(r.corrections.stale[0]!.message).toContain("meets no fact in this read");
  });

  it("meets the fact again when the next read gives it another id, by what it cites", async () => {
    const renamed = facts().map((f) =>
      f.id === "e-settle-listener" ? { ...f, id: "entry-settled" } : f,
    );
    const r = await verify(renamed);
    expect(r.accepted.map((f) => f.id)).not.toContain("entry-settled");
    expect(r.corrections.applied.map((a) => a.fact)).toContain("entry-settled");
  });

  it("checks a corrected claim on its line: one the code doesn't say is rejected, as any fact is", async () => {
    const wrongPath = FactCorrection.parse({
      ...corrections()[1],
      set: { path: "/customers/{accountId}" },
    });
    const r = await verify(facts(), [wrongPath]);
    // ...and what names it is rejected with it, as for any rejected fact.
    expect(r.rejected.map((x) => [x.fact.id, x.code, x.fact.by])).toEqual([
      ["e-get-account", "claim-not-on-line", "person"],
      ["s-account-read", "ref-rejected", "assistant"],
    ]);
  });

  it("moves a fact to the line a person says, drops the old quote, and meets it there next time", async () => {
    const moved = FactCorrection.parse({ ...corrections()[1], set: undefined, line: 18 });
    expect(moved.line).toBe(18);
    const off = facts().map((f) =>
      f.id === "e-get-account" ? { ...f, cite: { ...f.cite, line: 17, quote: "//" } } : f,
    );
    const once = applyCorrections(off, [{ ...moved, target: { ...moved.target, line: 17 } }]);
    const get = once.facts.find((f) => f.id === "e-get-account")!;
    expect(get.cite).toEqual({ file: get.cite.file, line: 18, value: "/accounts/{accountId}" });
    const again = applyCorrections(once.facts, [
      { ...moved, target: { ...moved.target, line: 17 } },
    ]);
    expect(again.applied.map((a) => a.fact)).toEqual(["e-get-account"]);
    expect(again.stale).toEqual([]);
    const r = await verify(once.facts, []);
    expect(r.rejected).toEqual([]);
  });

  it("keeps the fact as it was when the correction doesn't make one, and says why", () => {
    const bad = FactCorrection.parse({ ...corrections()[1], set: { entryType: "carrier-pigeon" } });
    const r = applyCorrections(facts(), [bad]);
    expect(r.facts.find((f) => f.id === "e-get-account")!.by).toBe("assistant");
    expect(r.stale.map((s) => s.why)).toEqual(["invalid"]);
    expect(r.stale[0]!.message).toContain("entryType");
  });

  it("the newest correction of a fact wins, and the older one isn't stale", () => {
    const [wrong] = corrections();
    const later = {
      ...wrong!,
      at: "2026-10-25T09:00:00Z",
      action: "edit" as const,
      reason: undefined,
      set: { handler: "SettlementListener.on" },
    };
    const r = applyCorrections(facts(), [wrong!, FactCorrection.parse(later)]);
    expect(r.applied).toEqual([{ fact: "e-settle-listener", action: "edit", by: wrong!.by }]);
    expect(r.stale).toEqual([]);
  });

  it("refuses a correction that marks a fact wrong without why, or sets what isn't a claim", () => {
    const [wrong, edit] = corrections();
    expect(FactCorrection.safeParse({ ...wrong, reason: undefined }).success).toBe(false);
    expect(FactCorrection.safeParse({ ...edit, set: { commit: "fff0000" } }).success).toBe(false);
    expect(FactCorrection.safeParse({ ...edit, set: undefined }).success).toBe(false);
    expect(FactCorrection.safeParse({ ...wrong, set: { path: "/x" } }).success).toBe(false);
    expect(parseCorrections('not json\n{"schemaVersion":1}\n').bad.map((b) => b.line)).toEqual([
      1, 2,
    ]);
  });
});
