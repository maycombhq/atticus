import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ChecklistPack, DEFAULT_CHANGE_TYPES, DEFAULT_GATES, type Lens } from "@maycombhq/core";
import { STARTER_REVIEW_FILE, STARTER_REVIEW_PATH, starterReviewText } from "../src/index.js";
import { prepareLayers, resolveGate } from "../src/round.js";

/**
 * The starter review (ADR 0120): AI rules every new metarepo gets in
 * org-pack/checklists/review.yaml, so the critic's lenses (ADR 0115) have something to judge.
 */

const NOW = "2026-10-23T09:00:00Z";

describe("the starter review checklist", () => {
  it("parses with contract C3: rules of the org layer, AI rules with a plain prompt and two code checks", async () => {
    expect(STARTER_REVIEW_PATH).toBe("checklists/review.yaml");
    const text = await starterReviewText();
    expect(text).toBe(await readFile(STARTER_REVIEW_FILE, "utf8"));
    expect(text.split("\n")[0]).toMatch(/^# Built-in default written out by Atticus/);
    expect(text).toContain("Change it through a");
    const pack = ChecklistPack.parse(parse(text));
    expect(pack.name).toBe("review");
    // Each rule's question (ADR 0124 addendum, Part 4) picks the lens that applies it; its role
    // lens still picks the change types it applies to.
    expect(
      pack.rules.map((r) => [r.id, r.lens, r.question, r.appliesTo.artifacts, r.severity]),
    ).toEqual([
      ["review.brief-outcomes-placed", "business", "complete", ["brief"], "blocking"],
      ["review.changed-flow-not-read", "architecture", "true", ["brief"], "blocking"],
      ["review.assumed-capability-named", "architecture", "true", ["brief"], "blocking"],
      ["review.outcome-has-target-steps", "architecture", "complete", ["design"], "blocking"],
      ["review.shown-data-has-a-source", "architecture", "true", ["design", "data"], "blocking"],
      ["review.new-column-complete", "architecture", "safe", ["data", "design"], "blocking"],
      ["review.hop-pattern-fits", "architecture", "safe", ["interfaces", "design"], "risk"],
      ["review.outcome-has-story", "story", "complete", ["stories"], "blocking"],
      ["review.criteria-testable", "story", "complete", ["stories"], "risk"],
      ["review.requests-raised-in-time", "delivery", "ship", ["tasks"], "risk"],
      // The code checks of the four questions the product owner moved out of the constitution
      // (2026-10-24): the org's to change, retire or delete; written for their question.
      ["review.call-timeout-stated", "safe", "safe", ["interfaces", "design", "catalog"], "risk"],
      ["review.store-write-rollback", "ship", "ship", ["data", "design", "catalog"], "risk"],
    ]);
    expect(
      pack.rules.flatMap((r) =>
        r.check.type === "deterministic" ? [[r.id, r.check.check, r.needs]] : [],
      ),
    ).toEqual([
      ["review.call-timeout-stated", "call-timeout-stated", []],
      ["review.store-write-rollback", "store-write-rollback", []],
    ]);
    for (const r of pack.rules) {
      // Configuration, not the constitution: an org can waive a blocking rule, or change it.
      expect(r.layer, r.id).toBe("org");
      expect(r.source, r.id).toBe("Atticus starter review");
      expect(r.waivable, r.id).toBe(r.severity === "blocking");
      if (r.check.type !== "ai") continue;
      const prompt = r.check.type === "ai" ? r.check.prompt : "";
      // Plain words that ask for meaning, and a quote of the cited line; no patterns.
      expect(prompt, r.id).toMatch(/quot/i);
      expect(prompt, r.id).not.toMatch(/[\\^$|]|\(\?|\[\^|\.\*/);
    }
  });
});

/** A metarepo on the built-in defaults with the starter review, and one change per type. */
async function metarepo(types = DEFAULT_CHANGE_TYPES.types): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-starter-review-"));
  await mkdir(join(root, "org-pack/checklists"), { recursive: true });
  await cp(STARTER_REVIEW_FILE, join(root, "org-pack", ...STARTER_REVIEW_PATH.split("/")));
  for (const t of types) {
    const d = join(root, "openspec/changes", `c-${t.id}`);
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "change.yaml"),
      [
        "schemaVersion: 1",
        `id: c-${t.id}`,
        `title: A ${t.id} change`,
        `type: ${t.id}`,
        `state: ${t.phases[0]}`,
        `createdAt: ${NOW}`,
        "createdBy: pat",
        "systems: []",
        "history:",
        `  - { from: draft, to: ${t.phases[0]}, at: ${NOW}, by: pat, reason: test }`,
        "",
      ].join("\n"),
    );
  }
  return root;
}

/** The starter rules the critic would apply to the change at the gate. */
async function starterRules(root: string, change: string, gate: string): Promise<string[]> {
  const g = await resolveGate(root, change, gate);
  const { applicable } = await prepareLayers(root, g, NOW, []);
  return applicable.filter((r) => r.id.startsWith("review.")).map((r) => r.id);
}

const DEFINE = [
  "review.brief-outcomes-placed",
  "review.changed-flow-not-read",
  "review.assumed-capability-named",
];
const DESIGN = [
  "review.outcome-has-target-steps",
  "review.shown-data-has-a-source",
  "review.new-column-complete",
  "review.hop-pattern-fits",
];
const PLAN = [
  "review.outcome-has-story",
  "review.criteria-testable",
  "review.requests-raised-in-time",
];
/** The code checks read the catalog, which is due at every gate. */
const TIMEOUT = "review.call-timeout-stated";
const ROLLBACK = "review.store-write-rollback";
const CODE = [TIMEOUT, ROLLBACK];

/** The default change types as they were before the four questions: the seven lenses by name. */
const OLD_LENSES: Record<string, Lens[]> = {
  feature: ["business", "architecture", "story", "ux", "delivery", "code-and-test", "release"],
  integration: ["business", "architecture", "story", "delivery", "code-and-test", "release"],
  "bug-fix": ["story", "code-and-test", "release"],
  "emergency-fix": ["code-and-test", "release"],
  "config-change": ["architecture", "release"],
  "tech-debt": ["architecture", "code-and-test"],
  "small-change": ["architecture", "story", "code-and-test", "release"],
};

describe("the starter review with the default gates and change types", () => {
  it("runs at the gates whose artifacts each rule reads, with the questions each type asks", async () => {
    const root = await metarepo();
    const sorted = (xs: string[]) => [...xs].sort();
    const at = async (type: string, gate: string) =>
      sorted(await starterRules(root, `c-${type}`, gate));
    // Every default gate names no checklist, so every org checklist runs at it.
    expect(DEFAULT_GATES.gates.every((g) => g.checklists.length === 0)).toBe(true);

    expect(await at("feature", "define")).toEqual(sorted([...DEFINE, ...CODE]));
    expect(await at("feature", "design")).toEqual(sorted([...DEFINE, ...DESIGN, ...CODE]));
    expect(await at("feature", "plan")).toEqual(sorted([...DEFINE, ...DESIGN, ...PLAN, ...CODE]));
    expect(await at("integration", "define")).toEqual(sorted([...DEFINE, ...CODE]));
    expect(await at("integration", "plan")).toEqual(
      sorted([...DEFINE, ...DESIGN, ...PLAN, ...CODE]),
    );
    // The fast path's one gate: the small-change type asks all four questions (its architecture,
    // story, code-and-test and release lenses covered them), so it gets every rule whose
    // artifacts it has, the business and delivery ones included.
    expect(await at("small-change", "plan")).toEqual(
      sorted([...DEFINE, ...DESIGN, ...PLAN, ...CODE]),
    );
    // A type without a brief or a design gets no rule that reads them; a type that doesn't ask a
    // question gets none of its rules (tech-debt doesn't ask ship, bug-fix neither true nor safe).
    expect(await at("tech-debt", "design")).toEqual(sorted([...DESIGN, TIMEOUT]));
    expect(await at("bug-fix", "plan")).toEqual(
      sorted(["review.requests-raised-in-time", ROLLBACK]),
    );
    expect(await at("config-change", "plan")).toEqual(
      sorted(["review.requests-raised-in-time", ...CODE]),
    );
  });

  it("keeps an org pack's change types that list the old lenses by name as they were", async () => {
    const old = DEFAULT_CHANGE_TYPES.types.map((t) => ({ ...t, lenses: OLD_LENSES[t.id]! }));
    const root = await metarepo(old);
    await writeFile(
      join(root, "org-pack/change-types.yaml"),
      stringify({ schemaVersion: 2, types: old }),
    );
    const sorted = (xs: string[]) => [...xs].sort();
    const at = async (type: string, gate: string) =>
      sorted(await starterRules(root, `c-${type}`, gate));
    // A rule written for an old lens applies where the type lists that lens (or its question); a
    // rule written for a question, where a lens covers it (release covers ship, architecture safe).
    expect(await at("small-change", "plan")).toEqual(
      sorted([
        "review.changed-flow-not-read",
        "review.assumed-capability-named",
        ...DESIGN,
        "review.outcome-has-story",
        "review.criteria-testable",
        ...CODE,
      ]),
    );
    expect(await at("tech-debt", "design")).toEqual(sorted([...DESIGN, TIMEOUT]));
    expect(await at("bug-fix", "plan")).toEqual([ROLLBACK]);
    expect(await at("config-change", "plan")).toEqual(sorted(CODE));
  });

  it("a change type that lists no lenses uses every lens, so it gets every starter rule", async () => {
    const root = await metarepo([]);
    await writeFile(
      join(root, "org-pack/change-types.yaml"),
      [
        "schemaVersion: 2",
        "types:",
        "  - id: plain",
        "    name: Plain change",
        "    phases: [define, design, plan, build]",
        "    artifacts: [brief, proposal, design, data, interfaces, stories, tasks]",
        "",
      ].join("\n"),
    );
    const d = join(root, "openspec/changes/c-plain");
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "change.yaml"),
      `schemaVersion: 1\nid: c-plain\ntitle: Plain\ntype: plain\nstate: define\ncreatedAt: ${NOW}\ncreatedBy: pat\nsystems: []\nhistory:\n  - { from: draft, to: define, at: ${NOW}, by: pat, reason: test }\n`,
    );
    expect(await starterRules(root, "c-plain", "define")).toEqual([...DEFINE, ...CODE]);
    expect((await starterRules(root, "c-plain", "plan")).sort()).toEqual(
      [...DEFINE, ...DESIGN, ...PLAN, ...CODE].sort(),
    );
  });
});
