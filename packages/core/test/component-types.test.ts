import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMPONENT_TYPES,
  COMPONENT_TYPES,
  ComponentType,
  effectiveComponentTypes,
  Fact,
  loadOrgPack,
  projectFacts,
} from "../src/index.js";

/**
 * Component types the organisation owns (ADR 0180): Atticus's built-ins in the org pack's shape,
 * an architect's own type with its notes, a built-in reworded under its id, one switched off;
 * and the component fact that says what a component is. On the invented Forge fixture.
 */
const PACK = join(__dirname, "..", "..", "..", "fixtures", "component-types", "org-pack");

describe("the set of component types", () => {
  it("has every documented Component.type as a built-in, each with a shape and a badge", () => {
    expect(BUILTIN_COMPONENT_TYPES.map((t) => t.id)).toEqual([...COMPONENT_TYPES]);
    for (const t of BUILTIN_COMPONENT_TYPES) {
      expect(
        ComponentType.safeParse({ ...t, source: undefined, notesText: undefined }).success,
      ).toBe(false); // the loaded shape carries two fields the file doesn't
      const { source: _s, notesText: _n, ...file } = t;
      expect(ComponentType.safeParse(file).success).toBe(true);
      expect(t.draws?.badge).toBeTruthy();
    }
  });

  it("loads the organisation's types with their notes, rewords a built-in under its id, and takes one out", async () => {
    const op = await loadOrgPack(PACK);
    expect(op.problems.filter((p) => p.file.startsWith("component-types"))).toEqual([]);
    expect(op.componentTypes.map((t) => t.id)).toEqual([
      "forge-experience-api",
      "gateway",
      "ml-model",
    ]);
    const xp = op.componentTypes.find((t) => t.id === "forge-experience-api")!;
    expect(xp.notesText).toContain("# Experience APIs at Forge");
    expect(xp.mustNot).toHaveLength(2);
    const all = effectiveComponentTypes(op.componentTypes);
    // The built-ins keep their order; the organisation's own come after; ml-model is gone.
    expect(all.map((t) => t.id)).toEqual([
      ...COMPONENT_TYPES.filter((t) => t !== "ml-model"),
      "forge-experience-api",
    ]);
    const gw = all.find((t) => t.id === "gateway")!;
    expect(gw.name).toBe("Forge gateway proxy");
    expect(gw.source).toBe("org-pack");
    // The organisation's draws fill in over the built-in's.
    expect(gw.draws).toMatchObject({ shape: "diamond", colour: "#e06c75", badge: "gw" });
  });

  it("switches a built-in off without restating its words, and asks for them otherwise", () => {
    const off = ComponentType.safeParse({ schemaVersion: 1, id: "ml-model", off: true });
    expect(off.success).toBe(true);
    expect(off.data!.name).toBe("ml-model");
    const bare = ComponentType.safeParse({ schemaVersion: 1, id: "x" });
    expect(bare.success).toBe(false);
    expect(bare.error!.issues.map((i) => i.path.join("."))).toEqual(["name", "description"]);
  });

  it("refuses a type that isn't one: a badge too long, a notes file that isn't Markdown, an unknown field", () => {
    const base = { schemaVersion: 1, id: "x", name: "X", description: "An x." };
    expect(ComponentType.safeParse(base).success).toBe(true);
    expect(ComponentType.safeParse({ ...base, draws: { badge: "long" } }).success).toBe(false);
    expect(ComponentType.safeParse({ ...base, notes: "notes.txt" }).success).toBe(false);
    expect(ComponentType.safeParse({ ...base, colour: "red" }).success).toBe(false);
  });
});

describe("the component fact", () => {
  const ev = (id: string, kind: string, more: Record<string, unknown>) => ({
    id,
    kind,
    repo: "forge-web-xp",
    commit: "abc1234",
    cite: { file: "package.json", line: 12, value: "@forge/experience-kit" },
    ...more,
  });

  it("says what a component is, cited on its signal's line, and the projection takes the type", () => {
    const facts = [
      ev("e1", "entry", {
        entryType: "rest",
        method: "GET",
        path: "/v1/home",
        cite: { file: "src/experience/home.ts", line: 3, value: "/v1/home" },
      }),
      ev("c1", "component", { type: "forge-experience-api", why: "built on the experience kit" }),
    ].map((f) => Fact.parse(f));
    const r = projectFacts(facts, { system: "forge" });
    const c = r.records.find((x) => x.kind === "Component")!;
    expect(c).toMatchObject({ id: "forge-web-xp", type: "forge-experience-api" });
    // The type's own citation is kept beside the component's.
    expect((c as { evidence: { line: number }[] }).evidence.some((e) => e.line === 12)).toBe(true);
    // Without one, the old reading stands.
    const plain = projectFacts([facts[0]!], { system: "forge" });
    expect(plain.records.find((x) => x.kind === "Component")).toMatchObject({ type: "service" });
    expect(Fact.safeParse(ev("c2", "component", {})).success).toBe(false);
  });
});
