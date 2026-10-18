import { describe, expect, it } from "vitest";
import { ChecklistPack, type ChecklistRule } from "@maycombhq/core";
import { layerRules, loadConstitution, loosenings, type PackSource } from "../src/index.js";

const rule = (r: Partial<ChecklistRule> & { id: string; layer: ChecklistRule["layer"] }) =>
  ({
    title: r.id,
    lens: "architecture",
    appliesTo: { artifacts: ["interfaces"], changeTypes: [] },
    severity: "blocking",
    check: { type: "deterministic", check: "interface-has-pattern", params: {} },
    evidenceRequired: true,
    waivable: false,
    source: "test",
    status: "active",
    needs: [],
    ...r,
  }) as ChecklistRule;

const pack = (name: string, rules: ChecklistRule[]): ChecklistPack =>
  ChecklistPack.parse({ schemaVersion: 1, name, version: "1.0.0", rules });

const constitution: PackSource = {
  origin: "constitution",
  file: "built-in",
  pack: pack("constitution", [
    rule({
      id: "c.story",
      layer: "constitution",
      lens: "story",
      appliesTo: { artifacts: ["stories"], changeTypes: [] },
      check: { type: "deterministic", check: "story-has-acceptance-criteria", params: {} },
      needs: [
        {
          kind: "System",
          field: "owner",
          scope: "touched-systems",
          question: "Who owns ${record}?",
        },
      ],
    }),
  ]),
};
const org: PackSource = {
  origin: "org",
  file: "org-pack/checklists/arch.yaml",
  pack: pack("arch", [
    rule({
      id: "o.hop",
      layer: "org",
      severity: "risk",
      check: {
        type: "deterministic",
        check: "settings-present",
        params: { settingKinds: ["timeout"], forBoundary: "vendor" },
      },
    }),
  ]),
};

describe("rule layering", () => {
  it("loads the built-in constitution as a valid C3 pack of non-waivable constitution rules", async () => {
    const c = await loadConstitution();
    expect(c.name).toBe("constitution");
    expect(c.rules.length).toBeGreaterThanOrEqual(10);
    for (const r of c.rules) {
      expect(r.layer).toBe("constitution");
      expect(r.waivable).toBe(false);
      expect(r.check.type).toBe("deterministic");
    }
    const ids = c.rules.map((r) => r.id);
    for (const id of [
      "constitution.interface-approved-pattern",
      "constitution.interface-ends-in-catalog",
      "constitution.data-doc-present",
      "constitution.story-acceptance-criteria",
      "constitution.snow-drafts-present",
    ])
      expect(ids).toContain(id);
  });

  it("lets a team tighten an org rule and add its own; the tightened rule replaces the original", () => {
    const team: PackSource = {
      origin: "team",
      file: "org-pack/teams/t/checklists/t.yaml",
      pack: pack("t", [
        rule({
          id: "t.hop",
          layer: "team",
          tightens: "o.hop",
          severity: "blocking",
          waivable: true,
          check: {
            type: "deterministic",
            check: "settings-present",
            params: { settingKinds: ["timeout", "retry"] },
          },
        }),
        rule({ id: "t.extra", layer: "team", severity: "idea" }),
      ]),
    };
    const r = layerRules([team, org, constitution]);
    expect(r.refused).toEqual([]);
    expect(r.rules.map((x) => x.id).sort()).toEqual(["c.story", "t.extra", "t.hop"]);
    const t = r.rules.find((x) => x.id === "t.hop")!;
    expect(t.replaces).toEqual(["o.hop"]);
    expect(t.effectiveLayer).toBe("org");
  });

  it("keeps a tightened constitution rule at the constitution layer and never waivable", () => {
    const team: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [
        rule({
          id: "t.story",
          layer: "team",
          tightens: "c.story",
          lens: "story",
          appliesTo: { artifacts: ["stories", "specs"], changeTypes: [] },
          check: {
            type: "deterministic",
            check: "story-has-acceptance-criteria",
            params: { strict: true },
          },
          needs: [
            {
              kind: "System",
              field: "owner",
              scope: "touched-systems",
              question: "Who owns ${record}?",
            },
          ],
        }),
      ]),
    };
    const r = layerRules([constitution, team]);
    expect(r.refused).toEqual([]);
    const t = r.rules.find((x) => x.id === "t.story")!;
    expect(t.effectiveLayer).toBe("constitution");
    expect(t.waivable).toBe(false);
    expect(r.rules.some((x) => x.id === "c.story")).toBe(false);
  });

  it("refuses a whole team pack that loosens or drops a constitution rule, and says why", () => {
    const loosen: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [
        rule({ id: "t.ok", layer: "team" }),
        rule({
          id: "t.story",
          layer: "team",
          tightens: "c.story",
          lens: "story",
          severity: "risk",
          appliesTo: { artifacts: ["stories"], changeTypes: [] },
          check: { type: "deterministic", check: "story-has-acceptance-criteria", params: {} },
        }),
      ]),
    };
    const r = layerRules([constitution, loosen]);
    expect(r.rules.map((x) => x.id)).toEqual(["c.story"]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]!.reason).toMatch(
      /loosens c\.story: it lowers severity from blocking to risk; it drops needed facts \(System\.owner\)/,
    );

    const drop: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [
        rule({
          id: "t.story",
          layer: "team",
          tightens: "c.story",
          lens: "story",
          status: "retired",
          appliesTo: { artifacts: ["stories"], changeTypes: [] },
          check: { type: "deterministic", check: "story-has-acceptance-criteria", params: {} },
          needs: constitution.pack.rules[0]!.needs,
        }),
      ]),
    };
    const d = layerRules([constitution, drop]);
    expect(d.refused[0]!.reason).toMatch(/status retired, which drops the rule/);
    expect(d.rules.map((x) => x.id)).toEqual(["c.story"]);

    const redefine: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [rule({ id: "c.story", layer: "team" })]),
    };
    expect(layerRules([constitution, redefine]).refused[0]!.reason).toMatch(
      /redefines rule c\.story/,
    );

    const extend: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [rule({ id: "t.x", layer: "team", extends: "c.story" })]),
    };
    expect(layerRules([constitution, extend]).refused[0]!.reason).toMatch(
      /can only be tightened, not extended/,
    );
  });

  it("refuses a team pack that declares org or constitution rules", () => {
    const sneaky: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [rule({ id: "t.org", layer: "org" })]),
    };
    const r = layerRules([constitution, sneaky]);
    expect(r.refused[0]!.reason).toBe("a team pack can't declare org rules (rule t.org)");
  });

  it("refuses an org pack that loosens a constitution rule, and leaves out a team rule that loosens an org rule", () => {
    const badOrg: PackSource = {
      origin: "org",
      file: "org.yaml",
      pack: pack("o2", [
        rule({
          id: "o.story",
          layer: "org",
          tightens: "c.story",
          lens: "story",
          waivable: true,
          appliesTo: { artifacts: ["stories"], changeTypes: [] },
          check: { type: "deterministic", check: "story-has-acceptance-criteria", params: {} },
          needs: constitution.pack.rules[0]!.needs,
        }),
      ]),
    };
    const r = layerRules([constitution, badOrg]);
    expect(r.refused[0]!.reason).toMatch(/makes the rule waivable/);
    expect(r.problems).toContain(
      "org.yaml: refused because it drops or loosens a constitution rule",
    );

    const team: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [
        rule({
          id: "t.hop",
          layer: "team",
          tightens: "o.hop",
          severity: "idea",
          check: { type: "deterministic", check: "settings-present", params: {} },
        }),
      ]),
    };
    const t = layerRules([constitution, org, team]);
    expect(t.rules.map((x) => x.id).sort()).toEqual(["c.story", "o.hop"]);
    expect(t.refused[0]!.reason).toMatch(/lowers severity from risk to idea/);
  });

  it("merges an extending rule's check parameters and needs with its base", () => {
    const team: PackSource = {
      origin: "team",
      file: "team.yaml",
      pack: pack("t", [
        rule({
          id: "t.hop2",
          layer: "team",
          extends: "o.hop",
          severity: "risk",
          check: {
            type: "deterministic",
            check: "settings-present",
            params: { forBoundary: "internal" },
          },
        }),
      ]),
    };
    const r = layerRules([constitution, org, team]);
    const t = r.rules.find((x) => x.id === "t.hop2")!;
    expect(t.check).toEqual({
      type: "deterministic",
      check: "settings-present",
      params: { settingKinds: ["timeout"], forBoundary: "internal" },
    });
    expect(r.rules.some((x) => x.id === "o.hop")).toBe(true);
  });

  it("lists every way a tightening loosens its base", () => {
    const base = rule({
      id: "b",
      layer: "org",
      appliesTo: { artifacts: ["interfaces", "design"], changeTypes: [] },
    });
    const next = rule({
      id: "n",
      layer: "team",
      lens: "delivery",
      evidenceRequired: false,
      appliesTo: { artifacts: ["interfaces"], changeTypes: ["feature"] },
      check: { type: "ai", prompt: "Look for anything at all that is wrong here." },
    });
    expect(loosenings(base, next)).toEqual([
      "it stops requiring evidence",
      "it moves the rule from the architecture lens to delivery",
      "it no longer looks at design",
      "it applies to fewer change types",
      "it swaps a deterministic check for a ai one",
    ]);
  });
});
