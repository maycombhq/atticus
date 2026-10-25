import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  checkStories,
  criteriaFor,
  renderStoryFile,
  StoriesAnswerSchema,
  unwrittenChecks,
  type DeltaStory,
  type StoriesAnswer,
} from "../src/index.js";

/**
 * A criterion written once accepts several tasks (ADR 0124 addendum B-once). The deliverBy
 * change (fixtures/stages/stories-once/) passes one field through four tasks: written per task
 * it takes 8 criteria (repeated.yaml), written once with `also` it takes 4 (answer.yaml), and
 * the checks, the story file and each task's list read the shared ones. Invented: Forge.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "stages", "stories-once");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");
const STORIES = parse(read("stories.yaml")) as DeltaStory[];
const answer = (f = "answer.yaml"): StoriesAnswer => StoriesAnswerSchema.parse(parse(read(f)));
const check = (a: StoriesAnswer) =>
  checkStories(a, STORIES, [], [], { sections: true, known: new Set() });
const blocking = (a: StoriesAnswer) => check(a).filter((i) => i.blocking);
const rules = (a: StoriesAnswer) => check(a).map((i) => i.rule);
const story = (a: StoriesAnswer) => a.stories[0]!;
const task = (a: StoriesAnswer, id: string) => story(a).tasks.find((t) => t.id === id)!;
const SHARED =
  "Given a client, when it posts an order with deliverBy 2026-11-02, then 201 returns deliverBy 2026-11-02 and the orders row holds deliver_by 2026-11-02";

/** The bullets under a story file's "## Acceptance criteria" heading. */
function listed(md: string): string[] {
  const lines = md.split("\n");
  const at = lines.indexOf("## Acceptance criteria");
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("## ")) break;
    if (l.startsWith("- ")) out.push(l.slice(2));
  }
  return out;
}

/** The criteria bullets under a task's "- Acceptance criteria:" in the story file. */
function taskListed(md: string, id: string): string[] {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`### Task ${id}:`));
  const from = lines.indexOf("- Acceptance criteria:", at);
  const out: string[] = [];
  for (const l of lines.slice(from + 1)) {
    if (!l.startsWith("  - ")) break;
    out.push(l.slice(4));
  }
  return out;
}

describe("a criterion written once accepts several tasks (B-once)", () => {
  it("reads `also` as optional: an answer without it parses as before, with no also", () => {
    const old = answer("repeated.yaml");
    expect(task(old, "1.1").criteria[0]).not.toHaveProperty("also");
    expect(task(answer(), "1.1").criteria[0]!.also).toEqual(["1.2", "1.3", "1.4"]);
  });

  it("says the deliverBy story in 4 criteria where repeating them took 8", () => {
    const before = renderStoryFile("add-deliver-by", STORIES[0]!, story(answer("repeated.yaml")));
    const after = renderStoryFile("add-deliver-by", STORIES[0]!, story(answer()));
    expect(listed(before)).toHaveLength(8);
    expect(listed(after)).toHaveLength(4);
    // the story's list names the other tasks a criterion accepts
    expect(listed(after)[0]).toBe(`${SHARED}. (also accepts tasks 1.2, 1.3 and 1.4)`);
    expect(listed(after)[1]).toMatch(/\(also accepts task 1\.2\)$/);
    expect(listed(after)[2]).not.toContain("also accepts");
  });

  it("passes the checks both ways: a task's criteria are its own and the ones naming it in also", () => {
    expect(blocking(answer("repeated.yaml"))).toEqual([]);
    expect(blocking(answer())).toEqual([]);
    const r = rules(answer());
    // 1.4 has no criteria of its own; the shared one accepts it and checks its deliverBy
    expect(r).not.toContain("stories.no-criteria");
    expect(r).not.toContain("stories.field-not-checked");
    // the validation and the write fail somewhere their criteria say: 1.2 by its own and 1.1's
    expect(r).not.toContain("stories.no-error-case");
    expect(r).not.toContain("stories.field-no-error-case");
  });

  it("gives each task the criteria that accept it, its own first, then the shared ones", () => {
    const w = story(answer());
    expect(criteriaFor(w, "1.1").map((c) => c.text)).toHaveLength(2);
    expect(criteriaFor(w, "1.2").map((c) => c.text)).toEqual([
      task(answer(), "1.2").criteria[0]!.text,
      SHARED,
      task(answer(), "1.1").criteria[1]!.text,
    ]);
    expect(criteriaFor(w, "1.4").map((c) => c.text)).toEqual([SHARED]);
  });

  it("covers a field through also, and without it asks again", () => {
    const a = answer();
    delete task(a, "1.1").criteria[0]!.also;
    const issues = check(a);
    const of = (rule: string) => issues.filter((i) => i.rule === rule).map((i) => i.target);
    expect(of("stories.no-criteria")).toEqual(["1.4"]);
    expect(of("stories.field-not-checked")).toEqual(["1.3"]);
    // deliver_by is 1.3's field: 1.1's criterion may check it only while it accepts 1.3
    expect(of("stories.unknown-check")).toEqual(["1.1:deliver_by"]);
  });

  it("finds a task's error criterion among the shared ones", () => {
    const a = answer();
    task(a, "1.2").criteria = [];
    // 1.2 validates; its one error criterion now is 1.1's malformed date, which accepts 1.2
    expect(rules(a)).not.toContain("stories.no-error-case");
    delete task(a, "1.1").criteria[1]!.also;
    expect(check(a).find((i) => i.rule === "stories.no-error-case")?.target).toBe("1.2");
  });

  it("refuses an also that names a task the story doesn't have", () => {
    const a = answer();
    task(a, "1.1").criteria[1]!.also = ["1.2", "1.9"];
    const i = check(a).find((x) => x.rule === "stories.unknown-also");
    expect(i).toMatchObject({
      target: "s1-deliver-by:1.1:1.9",
      blocking: true,
      repo: "forge-orders",
    });
    expect(i!.message).toContain("1.9");
  });

  it("puts a shared criterion in each task's list and prompt in the story file", () => {
    const md = renderStoryFile("add-deliver-by", STORIES[0]!, story(answer()));
    expect(taskListed(md, "1.4")).toEqual([
      `${SHARED}. (Entry: POST /orders; written on task 1.1)`,
    ]);
    expect(taskListed(md, "1.2")).toHaveLength(3);
    const prompt1_4 = md.slice(md.indexOf("Implement task 1.4"));
    expect(prompt1_4.slice(0, prompt1_4.indexOf("```"))).toContain(
      `- ${SHARED} (checks deliverBy, deliver_by)`,
    );
  });

  it("asks the judge of a shared criterion's check once, on the task it is written on", () => {
    const a = answer();
    task(a, "1.1").criteria[0]!.text =
      "Given a client, when it posts an order with deliverBy 2026-11-02, then 201 returns it and the row holds the date";
    expect(unwrittenChecks(a, STORIES)).toEqual([
      {
        task: "1.1",
        repo: "forge-orders",
        field: "deliverBy",
        criterion: task(a, "1.1").criteria[0]!.text,
      },
      {
        task: "1.1",
        repo: "forge-orders",
        field: "deliver_by",
        criterion: task(a, "1.1").criteria[0]!.text,
      },
    ]);
  });
});
