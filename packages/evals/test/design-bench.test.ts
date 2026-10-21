import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { readFigma } from "@maycombhq/planner";
import { parseDesignReference, runDesignBench, type DesignReference } from "../src/index.js";

// ADR 0087: the design bench, run with hand-written assistant answers (MockRuntime).

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "../../../bench");
const REF = parseDesignReference(readFileSync(join(BENCH, "design/reference.yaml"), "utf8"));
const READ = readFigma(readFileSync(join(BENCH, "design/vaccinations.figma.json"), "utf8"));
const NOW = new Date("2026-10-21T09:00:00Z");

/** The answer a correct reading gives, written from the reference itself. */
function perfect(ref: DesignReference, edit: (a: ReturnType<typeof build>) => void = () => {}) {
  const a = build(ref);
  edit(a);
  return stringify(a);
}

function build(ref: DesignReference) {
  const named = new Set(
    ref.screens.flatMap((s) => [...s.fields, ...s.actions].map((x) => x.figma_id)),
  );
  return {
    design: {
      screens: ref.screens.map((s) => ({
        figmaId: s.figma_id,
        name: s.frame,
        fields: s.fields.map((f) => ({
          figmaId: f.figma_id,
          label: f.label,
          backing: f.backing,
          ...(f.maps_to ? { mapsTo: f.maps_to } : {}),
          ...(f.gap ? { gap: f.gap } : {}),
        })) as Record<string, unknown>[],
        actions: s.actions.map((x) => ({
          figmaId: x.figma_id,
          label: x.label,
          ...(x.existing_endpoint
            ? {
                endpoint: /^(GET|POST|PUT|DELETE)\s/.test(x.existing_endpoint)
                  ? x.existing_endpoint
                  : "none",
              }
            : {}),
          ...(x.gap ? { gap: x.gap } : {}),
        })) as Record<string, unknown>[],
      })),
      ignored: READ.screens
        .flatMap((s) => [...s.fields, ...s.actions])
        .filter((x) => !named.has(x.figmaId))
        .map((x) => ({ figmaId: x.figmaId, why: "Not data the feature needs" })),
    },
    gaps: ref.gaps.map((g) => ({ what: g.what, why: g.why })),
  };
}

const runtime = (answers: string[], prompts: string[] = []) => {
  let n = 0;
  return new MockRuntime(
    (req) => {
      prompts.push(req.pack.prompt);
      return answers[Math.min(n++, answers.length - 1)]!;
    },
    { now: () => NOW },
  );
};

describe("the design bench", () => {
  it("scores a correct reading in full", async () => {
    const prompts: string[] = [];
    const r = await runDesignBench({
      bench: BENCH,
      runtime: runtime([perfect(REF)], prompts),
      now: NOW,
    });
    if (r.status !== "scored") throw new Error("not scored");
    expect(r.problems).toEqual([]);
    expect(r.drafts).toBe(1);
    // The design and the estate went in as data.
    expect(prompts[0]).toContain('field I20:7;3:1 "Vaccine" (table-column)');
    expect(prompts[0]).toContain("flow add-visit");
    expect(prompts[0]).toContain(
      "endpoint POST /petclinic/api/owners/{ownerId}/pets/{petId}/visits",
    );
    const s = r.score;
    expect(s.screens).toEqual({ found: 5, of: 5, missed: [] });
    expect(s.fields).toMatchObject({ found: s.fields.of, precision: 1, recall: 1, extra: [] });
    expect(s.backing).toMatchObject({ correct: s.fields.of, wrong: [] });
    expect(s.actions).toMatchObject({ mapped: s.actions.of, wrong: [] });
    expect(s.gaps).toMatchObject({ found: s.gaps.of, missed: [] });
  });

  it("counts a reading that falls into a trap as wrong, and sends an unmapped element back first", async () => {
    const trapped = perfect(REF, (a) => {
      const pet = a.design.screens.find((x) => x.figmaId === "20:1")!;
      pet.fields.find((f) => f.figmaId === "20:3")!.mapsTo =
        "Owner.firstName, Owner.lastName, read from Pet.owner";
      const add = a.design.screens.find((x) => x.figmaId === "30:1")!;
      const save = add.actions.find((x) => x.figmaId === "30:12")!;
      save.endpoint = "POST /petclinic/api/owners/{ownerId}/pets/{petId}/visits";
      const vaccine = add.fields.find((f) => f.figmaId === "30:5")!;
      vaccine.backing = "existing";
      vaccine.mapsTo = "Visit.description (visits.description)";
    });
    // The first answer forgets the Retry button; the checks send it back.
    const first = perfect(REF, (a) => {
      const s = a.design.screens.find((x) => x.figmaId === "50:1")!;
      s.actions = s.actions.filter((x) => x.figmaId !== "50:6");
    });
    const prompts: string[] = [];
    const r = await runDesignBench({
      bench: BENCH,
      runtime: runtime([first, trapped], prompts),
      now: NOW,
    });
    if (r.status !== "scored") throw new Error("not scored");
    expect(prompts[1]).toContain(
      '"Retry" (50:6) on "Vaccinations tab / Empty and error" is neither mapped nor set aside',
    );
    expect(r.drafts).toBe(2);
    expect(r.score.backing.wrong.map((w) => [w.figmaId, w.why])).toEqual([
      ["20:3", "fell into a trap: pet.owner"],
      ["30:5", "marked existing, is new"],
    ]);
    expect(r.score.actions.wrong).toEqual([
      expect.objectContaining({
        figmaId: "30:12",
        why: expect.stringContaining("(a trap), but nothing serves it today"),
      }),
    ]);
  });

  it("scores nothing found when the assistant maps nothing", async () => {
    const r = await runDesignBench({
      bench: BENCH,
      runtime: runtime([stringify({ design: { screens: [] } })]),
      now: NOW,
      attempts: 1,
    });
    if (r.status !== "scored") throw new Error("not scored");
    expect(r.score.screens.found).toBe(0);
    expect(r.score.fields.recall).toBe(0);
    expect(r.problems.length).toBeGreaterThan(0);
  });
});
