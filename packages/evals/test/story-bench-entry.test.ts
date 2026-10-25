import { describe, expect, it } from "vitest";
import { BenchStory, scoreStory } from "../src/story-bench.js";

/**
 * Error cases matched by entry as well as by step (B-fixes, problem 5): the stories stage writes
 * a task per flow step (entry, validate, lookup, write, respond) where a reference has a step per
 * code place, so the steps match one to one and an error case written on a sibling task of the
 * same endpoint scored nothing. The strict figure stays; the by-entry figure is beside it.
 * An invented Forge story: a pet's tag number on POST /pets.
 */

const ref = BenchStory.parse({
  schemaVersion: 1,
  story: "forge-pet-tag",
  title: "A pet has a tag number",
  repos: ["forge-pets"],
  steps: [
    {
      id: "dto",
      repo: "forge-pets",
      what: "NewPet gains tagNumber",
      entry: "POST /pets",
      at: "src/NewPet.java:8",
    },
    {
      id: "db",
      repo: "forge-pets",
      what: "pets gains tag_number",
      entry: "POST /pets",
      at: "src/schema.sql:12",
    },
    {
      id: "screen",
      repo: "forge-pets",
      what: "The add pet form has a tag field",
      entry: "screen /pets/add",
      at: "web/pet-add.html:20",
    },
  ],
  criteria: [
    {
      id: "c-dto",
      step: "dto",
      given: "a tag of 16 digits",
      when: "POST /pets is called",
      then: "400",
      fields: ["tagNumber"],
      errors: [
        { field: "tagNumber", rule: "format", status: 400, when: "16 digits", then: "400" },
        {
          field: "tagNumber",
          rule: "unique",
          status: 409,
          when: "another pet has it",
          then: "409",
        },
      ],
    },
    {
      id: "c-db",
      step: "db",
      given: "a pet",
      when: "it is stored",
      then: "the row holds tag_number",
      fields: ["tag_number"],
    },
    {
      id: "c-screen",
      step: "screen",
      given: "a tag of 3 digits",
      when: "the form is sent",
      then: "the field is marked",
      fields: ["tagNumber"],
      errors: [{ field: "tagNumber", rule: "length", when: "3 digits", then: "marked" }],
    },
  ],
});

/** A draft with a task per flow step: the error cases sit on the validate and lookup tasks. */
const draft = BenchStory.parse({
  schemaVersion: 1,
  story: "forge-pet-tag",
  title: "A pet has a tag number",
  repos: ["forge-pets"],
  steps: [
    // the entry task matches the reference's dto step by file
    { id: "t1-1", repo: "forge-pets", what: "entry", entry: "POST /pets", at: "src/NewPet.java:9" },
    {
      id: "t1-2",
      repo: "forge-pets",
      what: "validate the tag",
      entry: "POST /pets",
      at: "src/PetController.java:30",
    },
    {
      id: "t1-3",
      repo: "forge-pets",
      what: "no other pet has the tag",
      entry: "POST /pets",
      at: "src/PetController.java:31",
    },
    {
      id: "t1-4",
      repo: "forge-pets",
      what: "store the tag",
      entry: "POST /pets",
      at: "src/schema.sql:12",
    },
  ],
  criteria: [
    {
      id: "t1-1-c1",
      step: "t1-1",
      given: "a pet",
      when: "POST /pets",
      then: "it is read",
      fields: ["tagNumber"],
    },
    {
      id: "t1-2-c1",
      step: "t1-2",
      given: "16 digits",
      when: "POST /pets",
      then: "400",
      entry: "POST /pets",
      fields: ["tagNumber"],
      errors: [{ field: "tagNumber", rule: "format", status: 400, when: "16 digits", then: "400" }],
    },
    {
      id: "t1-3-c1",
      step: "t1-3",
      given: "another pet has it",
      when: "POST /pets",
      then: "409",
      fields: ["tag_number"],
      // a column name for the field: the same field once folded through the reference's names
      errors: [{ field: "tagNumber", rule: "unique", status: 409, when: "taken", then: "409" }],
    },
    // a length error on POST /pets is not the screen's length error
    {
      id: "t1-4-c1",
      step: "t1-4",
      given: "3 digits",
      when: "POST /pets",
      then: "400",
      fields: ["tagNumber"],
      errors: [{ field: "tagNumber", rule: "length", when: "3 digits", then: "400" }],
    },
  ],
});

describe("error cases by entry (B-fixes, problem 5)", () => {
  it("keeps the strict figure: an error case counts only on the matching step", () => {
    const s = scoreStory(ref, draft);
    expect(s.errors).toEqual({
      found: 0,
      total: 3,
      missed: ["dto: tagNumber format", "dto: tagNumber unique", "screen: tagNumber length"],
      coverage: 0,
    });
  });

  it("matches an error case on another task of the same entry by field and rule", () => {
    const s = scoreStory(ref, draft);
    expect(s.errorsByEntry).toEqual({
      found: 2,
      total: 3,
      missed: ["screen: tagNumber length"],
      coverage: 2 / 3,
    });
  });

  it("never credits a case of another entry or repo, or another rule", () => {
    const other = BenchStory.parse({
      ...draft,
      steps: draft.steps.map((x) => (x.id === "t1-2" ? { ...x, entry: "PUT /pets/{id}" } : x)),
      criteria: draft.criteria.map((c) =>
        c.id === "t1-2-c1"
          ? { ...c, entry: "PUT /pets/{id}" }
          : c.id === "t1-3-c1"
            ? { ...c, errors: c.errors.map((e) => ({ ...e, rule: "conflict" as const })) }
            : c,
      ),
    });
    expect(scoreStory(ref, other).errorsByEntry.found).toBe(0);
  });

  it("a reference step with no entry is matched by step alone", () => {
    const bare = BenchStory.parse({
      ...ref,
      steps: ref.steps.map((x) => {
        const { entry: _e, ...rest } = x;
        return rest;
      }),
    });
    expect(scoreStory(bare, draft).errorsByEntry.found).toBe(0);
  });
});
