import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canaryClaimText, parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, planCanary, verifyFacts, type FileSource } from "../src/index.js";

/**
 * Canaries (plan item Z2, ADR 0196): the plan for a scratch copy, from the copy's files, the
 * repo's verified facts and a seed alone. One invented Forge repo per stack the templates cover:
 * Spring on Java (`forge-portal-bff`), Node on TypeScript (`forge-portal-ui`), Python
 * (`forge-appraise`). `fixtures/canaries/expected/<repo>.s1.json` is each plan, checked by hand.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const REPOS: Record<string, string> = {
  "forge-portal-bff": join(FIX, "forge/repos/forge-portal-bff"),
  "forge-portal-ui": join(FIX, "forge/repos/forge-portal-ui"),
  "forge-appraise": join(FIX, "reachable/forge-appraise"),
};
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "canaries/facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

/** The copy as the plan leaves it: the source's files, with the plan's writes over them. */
function planted(src: FileSource, writes: Record<string, string>): FileSource {
  return {
    list: () => [...new Set([...src.list(), ...Object.keys(writes)])].sort(),
    read: (p) => writes[p] ?? src.read(p),
  };
}

describe("planCanary", () => {
  for (const [repo, dir] of Object.entries(REPOS)) {
    it(`${repo}: the same seed plans the same, as checked by hand`, async () => {
      const facts = factsOf(repo);
      // The fixture's facts are all verified against the repo itself.
      const v = await verifyFacts({ facts, source: dirSource(dir) });
      expect(v.rejected.map((r) => `${r.fact.id} ${r.message}`)).toEqual([]);

      const a = planCanary({ source: dirSource(dir), facts, seed: "s1" });
      const b = planCanary({ source: dirSource(dir), facts: [...facts].reverse(), seed: "s1" });
      expect(b).toEqual(a);
      const expected = JSON.parse(
        readFileSync(join(FIX, "canaries/expected", `${repo}.s1.json`), "utf8"),
      ) as { stacks: string[]; planted: unknown[]; removed: unknown[] };
      expect({ stacks: a.stacks, planted: a.planted, removed: a.removed }).toEqual(expected);

      // Another seed draws other names (and, where there is a choice, other lines).
      const c = planCanary({ source: dirSource(dir), facts, seed: "s2" });
      expect(c.planted.map((p) => p.needle)).not.toEqual(a.planted.map((p) => p.needle));
    });
  }

  it("each planted line holds its claim, and no fact of the repo uses a planted word", () => {
    for (const [repo, dir] of Object.entries(REPOS)) {
      const facts = factsOf(repo);
      const plan = planCanary({ source: dirSource(dir), facts, seed: "s1" });
      const copy = planted(dirSource(dir), plan.writes);
      expect(plan.planted.length).toBeGreaterThanOrEqual(5);
      for (const p of plan.planted) {
        const line = copy.read(p.file)!.split("\n")[p.line - 1]!;
        const words = p.needle.split("-").filter((w) => !["updated", "viewed", "url"].includes(w));
        for (const w of words) expect(line.toLowerCase(), `${repo} ${p.id}`).toContain(w);
        expect(facts.some((f) => canaryClaimText(f).includes(words[0]!))).toBe(false);
      }
    }
  });

  it("comments out each removed line in place; the verifier refuses a claim cited on it", async () => {
    const dir = REPOS["forge-portal-bff"]!;
    const facts = factsOf("forge-portal-bff");
    const plan = planCanary({ source: dirSource(dir), facts, seed: "s1" });
    expect(plan.removed).toHaveLength(3);
    expect(new Set(plan.removed.map((r) => r.kind)).size).toBe(3);
    const copy = planted(dirSource(dir), plan.writes);
    for (const r of plan.removed) {
      const before = dirSource(dir).read(r.file)!.split("\n");
      const after = copy.read(r.file)!.split("\n");
      expect(after[r.line - 1]!.trim()).toMatch(/^(\/\/|#) /);
      expect(after[r.line - 1]!.replace(/(\/\/|#) /, "")).toBe(before[r.line - 1]);
      // every other line where it was: the line numbers of the file don't move
      expect(after.slice(0, r.line - 1)).toEqual(before.slice(0, r.line - 1));
    }
    // The old facts, cited on the commented lines, are caught (Flagged, not silent): what a
    // canary scores as passed is a claim the verifier kept, cited on a live line elsewhere.
    const removedFacts = facts.filter((f) => plan.removed.some((r) => r.fact === f.id));
    const v = await verifyFacts({ facts: removedFacts, source: copy });
    expect(v.accepted).toEqual([]);
    expect(v.rejected.map((r) => r.code)).toEqual([
      "claim-in-comment",
      "claim-in-comment",
      "claim-in-comment",
    ]);
  });

  it("takes out only as many lines as asked, and none it can't comment alone", () => {
    const dir = REPOS["forge-portal-bff"]!;
    const facts = factsOf("forge-portal-bff");
    expect(
      planCanary({ source: dirSource(dir), facts, seed: "s1", removals: 1 }).removed,
    ).toHaveLength(1);
    expect(planCanary({ source: dirSource(dir), facts, seed: "s1", removals: 0 }).removed).toEqual(
      [],
    );
    // a person's own fact, or one not verified, is never taken out
    const mine = facts.map((f) => ({ ...f, by: "person" as const }));
    expect(planCanary({ source: dirSource(dir), facts: mine, seed: "s1" }).removed).toEqual([]);
    const unchecked = facts.map((f) => ({ ...f, verified: "none" as const }));
    expect(planCanary({ source: dirSource(dir), facts: unchecked, seed: "s1" }).removed).toEqual(
      [],
    );
  });

  it("plants nothing in a repo of no stack it has a template for", () => {
    const src: FileSource = {
      list: () => ["main.go", "go.mod"],
      read: (p) => (p === "main.go" ? "package main\n" : "module forge\n"),
    };
    const plan = planCanary({ source: src, facts: [], seed: "s1" });
    expect(plan).toEqual({ stacks: [], planted: [], removed: [], writes: {} });
  });
});
