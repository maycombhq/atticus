import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReference } from "../src/bench.js";
import {
  benchKnownFields,
  parseDraftStory,
  parseReferenceStory,
  RUBRIC_SECTIONS,
  scoreStory,
} from "../src/story-bench.js";

/**
 * The stories bench (Phase B's first ticket): a drafted user story scored against a reference
 * story a person wrote by reading the code, on changed steps, fields, error cases, invented
 * fields and the rubric's sections. Deterministic: no model is asked anything.
 */

const ROOT = join(__dirname, "..", "..", "..");
const STORIES = join(ROOT, "bench", "stories");
const FIX = join(__dirname, "fixtures", "bench-stories");
const read = (p: string) => readFileSync(p, "utf8");

const microchip = () => parseReferenceStory(read(join(STORIES, "petclinic-pet-microchip.yaml")));
const known = () =>
  benchKnownFields([
    parseReference(read(join(ROOT, "bench", "references", "spring-petclinic-rest.yaml"))),
    parseReference(read(join(ROOT, "bench", "references", "spring-petclinic-angular.yaml"))),
  ]);

describe("stories bench: the reference stories", () => {
  const files = readdirSync(STORIES).filter((f) => f.endsWith(".yaml"));

  it("has three, each strict: every step cited and criticised, every criterion and error cited", () => {
    expect(files.sort()).toEqual([
      "fastapi-template-item-due-date.yaml",
      "microservices-demo-cart-limit.yaml",
      "petclinic-pet-microchip.yaml",
    ]);
    for (const f of files) {
      const s = parseReferenceStory(read(join(STORIES, f)));
      expect(`${s.story}.yaml`).toBe(f);
    }
  });

  it("each scores full marks against itself", () => {
    for (const f of files) {
      const s = parseReferenceStory(read(join(STORIES, f)));
      const self = scoreStory(s, parseDraftStory(read(join(STORIES, f))));
      expect(self.steps.missed, f).toEqual([]);
      expect(self.fields.missed, f).toEqual([]);
      expect(self.errors.missed, f).toEqual([]);
      expect(self.invented, f).toEqual([]);
      expect(self.sections.missing, f).toEqual([]);
    }
  });

  it("refuses a reference with an uncited step or a step no criterion covers", () => {
    const text = read(join(STORIES, "petclinic-pet-microchip.yaml"));
    expect(() =>
      parseReferenceStory(
        text.replace('    at: "src/app/pets/pet.ts:31"\n  - id: ui-submit', "  - id: ui-submit"),
      ),
    ).toThrow(/steps\.1\.at/);
    expect(() =>
      parseReferenceStory(text.replace("    step: ui-model\n", "    step: ui-form\n")),
    ).toThrow(/ui-model has no criterion/);
  });

  it("names the rubric's sections", () => {
    expect(RUBRIC_SECTIONS).toHaveLength(17);
    expect(RUBRIC_SECTIONS).toContain("nonFunctional.timeouts");
  });
});

describe("stories bench: scoring a draft", () => {
  it("scores a good draft: most steps, every field, most error cases, nothing invented", () => {
    const s = scoreStory(microchip(), parseDraftStory(read(join(FIX, "good-draft.yaml"))), known());
    expect(s.steps).toEqual({
      found: 7,
      total: 8,
      missed: ["api-lookup"],
      extra: [],
      coverage: 7 / 8,
    });
    expect(s.fields).toEqual({ found: 4, total: 4, missed: [], coverage: 1 });
    expect(s.errors).toEqual({
      found: 4,
      total: 5,
      missed: ["db-column: microchip unique"],
      coverage: 4 / 5,
    });
    expect(s.invented).toEqual([]);
    expect(s.sections).toEqual({ present: 17, total: 17, missing: [] });
    golden("good-draft.score.json", s);
  });

  it("scores a bad draft: one step, fields invented, no error cases, sections missing", () => {
    const s = scoreStory(microchip(), parseDraftStory(read(join(FIX, "bad-draft.yaml"))), known());
    expect(s.steps).toMatchObject({ found: 1, total: 8, extra: ["ui"] });
    expect(s.steps.missed).toEqual([
      "ui-form",
      "ui-model",
      "ui-submit",
      "api-entity",
      "api-duplicate",
      "api-lookup",
      "db-column",
    ]);
    expect(s.fields).toEqual({ found: 2, total: 4, missed: ["name", "type"], coverage: 0.5 });
    expect(s.errors).toMatchObject({ found: 0, total: 5 });
    expect(s.invented).toEqual(["chipVendor", "implantDate", "petName"]);
    expect(s.sections.present).toBe(5);
    expect(s.sections.missing).toEqual([
      "context",
      "scope.in",
      "scope.out",
      "criteria.per-step",
      "criteria.errors",
      "nonFunctional.auth",
      "nonFunctional.audit",
      "nonFunctional.timeouts",
      "nonFunctional.performance",
      "tests",
      "dependencies",
      "definitionOfDone",
    ]);
    golden("bad-draft.score.json", s);
  });

  it("knows the fields of the repo's facts, so a real field the reference doesn't name isn't invented", () => {
    const draft = parseDraftStory(read(join(FIX, "bad-draft.yaml")));
    const s = scoreStory(microchip(), draft, [...known(), "chipVendor"]);
    expect(s.invented).toEqual(["implantDate", "petName"]);
  });

  it("refuses a draft of another story, or one that doesn't read as a story", () => {
    const other = read(join(FIX, "good-draft.yaml")).replace(
      "story: petclinic-pet-microchip",
      "story: something-else",
    );
    expect(() => scoreStory(microchip(), parseDraftStory(other))).toThrow(/something-else/);
    expect(() => parseDraftStory("schemaVersion: 1\nstory: x\n")).toThrow(/title/);
  });
});

describe("stories bench: an error case with no field (B-run2-fixes 4)", () => {
  // An invented Forge story: cancelling an order, refused when no order has the id.
  const base = {
    schemaVersion: 1,
    story: "forge-cancel-order",
    title: "Cancel an order",
    repos: ["forge-orders"],
  };
  const criterion = (step: string, errors: object[], at?: string) => ({
    id: `${step}-c1`,
    step,
    given: "an order",
    when: "POST /orders/{id}/cancel is called",
    then: "the order is cancelled",
    errors,
    ...(at ? { at } : {}),
  });
  const ref = parseDraftStory(
    JSON.stringify({
      ...base,
      steps: [
        {
          id: "api-cancel",
          repo: "forge-orders",
          what: "cancel the order",
          entry: "POST /orders/{id}/cancel",
          at: "src/OrderController.java:20",
        },
      ],
      criteria: [
        criterion("api-cancel", [
          { rule: "not-found", status: 404, when: "no order has the id", then: "404" },
          {
            field: "reason",
            rule: "required",
            status: 400,
            when: "no reason is given",
            then: "400",
          },
        ]),
      ],
    }),
  );
  const draft = (errors: object[], o: { at?: string } = {}) =>
    parseDraftStory(
      JSON.stringify({
        ...base,
        steps: [
          {
            id: "t1-1",
            repo: "forge-orders",
            what: "cancel it",
            entry: "POST /orders/{id}/cancel",
            at: o.at ?? "src/OrderController.java:21",
          },
        ],
        criteria: [criterion("t1-1", errors)],
      }),
    );
  const found = (d: ReturnType<typeof draft>) => {
    const s = scoreStory(ref, d);
    return [s.errors.found, s.errorsByEntry.found];
  };

  it("matches a draft error keyed on the id field by the step, the rule and its when, strict and by entry", () => {
    expect(
      found(
        draft([
          { field: "id", rule: "not-found", when: "the order id names no order", then: "404" },
        ]),
      ),
    ).toEqual([1, 1]);
    // A draft error with no field matched as before.
    expect(found(draft([{ rule: "not-found", when: "the order is gone", then: "404" }]))).toEqual([
      1, 1,
    ]);
  });

  it("not on another rule, nor a when about something else", () => {
    expect(
      found(
        draft([{ field: "id", rule: "forbidden", when: "another client's order", then: "403" }]),
      ),
    ).toEqual([0, 0]);
    expect(
      found(
        draft([
          { field: "id", rule: "not-found", when: "the payments service is down", then: "404" },
        ]),
      ),
    ).toEqual([0, 0]);
    // A field error is matched by its field as before: the id field isn't the reason.
    expect(
      found(draft([{ field: "id", rule: "required", when: "no reason is given", then: "400" }])),
    ).toEqual([0, 0]);
  });

  it("on another step of the same entry: by entry, not strict", () => {
    const d = parseDraftStory(
      JSON.stringify({
        ...base,
        steps: [
          {
            id: "t1-1",
            repo: "forge-orders",
            what: "cancel it",
            entry: "POST /orders/{id}/cancel",
            at: "src/OrderController.java:21",
          },
          {
            id: "t1-2",
            repo: "forge-orders",
            what: "look it up",
            entry: "POST /orders/{id}/cancel",
            at: "src/OrderRepository.java:9",
          },
        ],
        criteria: [
          criterion("t1-1", []),
          criterion("t1-2", [
            { field: "id", rule: "not-found", when: "no order has the id", then: "404" },
          ]),
        ],
      }),
    );
    expect(found(d)).toEqual([0, 1]);
  });
});

function golden(file: string, s: unknown) {
  const path = join(FIX, file);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  expect(JSON.parse(JSON.stringify(s))).toEqual(JSON.parse(read(path)));
}
