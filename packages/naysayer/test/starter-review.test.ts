import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ChecklistPack, DEFAULT_CHANGE_TYPES, DEFAULT_GATES } from "@maycombhq/core";
import { STARTER_REVIEW_FILE, STARTER_REVIEW_PATH, starterReviewText } from "../src/index.js";
import { prepareLayers, resolveGate } from "../src/round.js";

/**
 * The starter review (ADR 0120): AI rules every new metarepo gets in
 * org-pack/checklists/review.yaml, so the critic's lenses (ADR 0115) have something to judge.
 */

const NOW = "2026-10-23T09:00:00Z";

describe("the starter review checklist", () => {
  it("parses with contract C3: AI rules of the org layer, each with a plain prompt", async () => {
    expect(STARTER_REVIEW_PATH).toBe("checklists/review.yaml");
    const text = await starterReviewText();
    expect(text).toBe(await readFile(STARTER_REVIEW_FILE, "utf8"));
    expect(text.split("\n")[0]).toMatch(/^# Built-in default written out by Atticus/);
    expect(text).toContain("Change it through a");
    const pack = ChecklistPack.parse(parse(text));
    expect(pack.name).toBe("review");
    expect(pack.rules.map((r) => [r.id, r.lens, r.appliesTo.artifacts, r.severity])).toEqual([
      ["review.brief-outcomes-placed", "business", ["brief"], "blocking"],
      ["review.changed-flow-not-read", "architecture", ["brief"], "blocking"],
      ["review.assumed-capability-named", "architecture", ["brief"], "blocking"],
      ["review.outcome-has-target-steps", "architecture", ["design"], "blocking"],
      ["review.shown-data-has-a-source", "architecture", ["design", "data"], "blocking"],
      ["review.new-column-complete", "architecture", ["data", "design"], "blocking"],
      ["review.hop-pattern-fits", "architecture", ["interfaces", "design"], "risk"],
      ["review.outcome-has-story", "story", ["stories"], "blocking"],
      ["review.criteria-testable", "story", ["stories"], "risk"],
      ["review.requests-raised-in-time", "delivery", ["tasks"], "risk"],
    ]);
    for (const r of pack.rules) {
      // Configuration, not the constitution: an org can waive a blocking rule, or change it.
      expect(r.layer, r.id).toBe("org");
      expect(r.waivable, r.id).toBe(r.severity === "blocking");
      expect(r.check.type, r.id).toBe("ai");
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

describe("the starter review with the default gates and change types", () => {
  it("runs at the gates whose artifacts each rule reads, with the lenses each type uses", async () => {
    const root = await metarepo();
    const sorted = (xs: string[]) => [...xs].sort();
    const at = async (type: string, gate: string) =>
      sorted(await starterRules(root, `c-${type}`, gate));
    // Every default gate names no checklist, so every org checklist runs at it.
    expect(DEFAULT_GATES.gates.every((g) => g.checklists.length === 0)).toBe(true);

    expect(await at("feature", "define")).toEqual(sorted(DEFINE));
    expect(await at("feature", "design")).toEqual(sorted([...DEFINE, ...DESIGN]));
    expect(await at("feature", "plan")).toEqual(sorted([...DEFINE, ...DESIGN, ...PLAN]));
    expect(await at("integration", "define")).toEqual(sorted(DEFINE));
    expect(await at("integration", "plan")).toEqual(sorted([...DEFINE, ...DESIGN, ...PLAN]));
    // The fast path's one gate: no business or delivery lens in the small-change type.
    expect(await at("small-change", "plan")).toEqual(
      sorted([
        "review.changed-flow-not-read",
        "review.assumed-capability-named",
        ...DESIGN,
        "review.outcome-has-story",
        "review.criteria-testable",
      ]),
    );
    // A type without a brief or a design gets no rule that reads them.
    expect(await at("tech-debt", "design")).toEqual(sorted(DESIGN));
    expect(await at("bug-fix", "plan")).toEqual([]);
    expect(await at("config-change", "plan")).toEqual([]);
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
    expect(await starterRules(root, "c-plain", "define")).toEqual(DEFINE);
    expect((await starterRules(root, "c-plain", "plan")).sort()).toEqual(
      [...DEFINE, ...DESIGN, ...PLAN].sort(),
    );
  });
});
