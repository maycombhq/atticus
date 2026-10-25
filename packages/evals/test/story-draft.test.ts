import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DONE,
  StoriesAnswerSchema,
  type DeltaStory,
  type RequestTask,
} from "@maycombhq/planner";
import { benchStoryFromStories, splitCriterion } from "../src/story-draft.js";
import { BenchStory, parseReferenceStory, scoreStory } from "../src/story-bench.js";

/**
 * A change's drafted stories (the stories stage's own format) as a BenchStory draft, so the
 * stories bench scores what Atticus writes (Phase B, B-stories-bench). Fixtures: the Forge fraud
 * check, fixtures/stages/stories-bench/ and fixtures/stages/stories/answer.yaml. Invented.
 */

const ROOT = join(__dirname, "..", "..", "..");
const FIX = join(ROOT, "fixtures", "stages", "stories-bench");
const read = (p: string) => readFileSync(p, "utf8");
const STORIES = parse(read(join(FIX, "stories.yaml"))) as DeltaStory[];
const ANSWER = () =>
  StoriesAnswerSchema.parse(
    parse(read(join(ROOT, "fixtures", "stages", "stories", "answer.yaml"))),
  );
const REQUESTS = [
  { id: "R1", title: "Network firewall rule", flow: "forge-orders.place-order" },
  { id: "R2", title: "Vendor onboarding", flow: "forge-orders.place-order" },
] as RequestTask[];

const convert = (stories = STORIES, answer = ANSWER()) =>
  benchStoryFromStories({
    story: "forge-fraud-check",
    change: "add-fraud-check",
    title: "Screen orders for fraud",
    stories,
    answer,
    done: DEFAULT_DONE,
    requests: REQUESTS,
  });

describe("a change's stories as a BenchStory draft", () => {
  it("writes the golden draft for the fraud check, every rubric section filled", () => {
    const got = convert();
    const want = BenchStory.parse(parse(read(join(FIX, "expected", "forge-fraud-check.yaml"))));
    expect(got).toEqual(want);
    // It is a valid draft, and scores against its reference with nothing invented.
    const ref = parseReferenceStory(read(join(FIX, "bench", "stories", "forge-fraud-check.yaml")));
    const s = scoreStory(ref, got);
    expect(s.sections).toMatchObject({ present: 17, total: 17 });
    expect(s.steps).toMatchObject({ found: 3, total: 4, missed: ["checkout"] });
    expect(s.fields).toMatchObject({ found: 5, total: 6, missed: ["cardLast4"] });
    expect(s.errors).toMatchObject({ found: 3, total: 4 });
    expect(s.invented).toEqual([]);
  });

  it("splits a criterion into given, when and then, and keeps one it can't split whole", () => {
    expect(
      splitCriterion("Given a cart with 9, when 2 more are added, then 400 says at most 10."),
    ).toEqual({ given: "a cart with 9", when: "2 more are added", then: "400 says at most 10" });
    expect(splitCriterion("given x when y then z")).toEqual({ given: "x", when: "y", then: "z" });
    expect(splitCriterion("The list shows the due date")).toEqual({
      given: "not said",
      when: "not said",
      then: "The list shows the due date",
    });
  });

  it("merges a change's stories across repos into one draft, the first story's statement first", () => {
    const web: DeltaStory = {
      id: "s2-checkout",
      repo: "forge-web",
      flow: "forge-web.checkout",
      name: "The shopper checks out",
      change: "modify",
      entry: "screen /checkout",
      dependsOn: ["s1-place-order"],
      kept: [],
      tasks: [
        {
          id: "2.1",
          story: "s2-checkout",
          repo: "forge-web",
          flow: "forge-web.checkout",
          op: "change",
          position: 1,
          kind: "call-out",
          title: "Change the call-out step: The checkout sends cardToken",
          what: "The checkout sends cardToken",
          fields: ["cardToken"],
          evidence: ["forge-web:src/checkout.ts:20"],
        },
      ],
    };
    const a = ANSWER();
    a.stories.push({
      id: "s2-checkout",
      title: "Send the card token",
      asA: "shopper",
      iWant: "to pay by card",
      soThat: "my order is screened",
      nonFunctional: { auth: "The shopper is signed in as today." },
      interfaces: { none: "the screen calls POST /orders, listed by s1" },
      data: { none: "the screen stores nothing" },
      dependencies: { stories: [], repos: [], notes: [] },
      tasks: [
        {
          id: "2.1",
          criteria: [
            {
              text: "Given a card, when the order is placed, then the request has cardToken",
              checks: ["cardToken"],
              outcome: "success",
            },
          ],
        },
      ],
    });
    const got = convert([...STORIES, web], a);
    expect(got.repos).toEqual(["forge-orders", "forge-web"]);
    expect(got.statement).toEqual({
      asA: "shop owner",
      iWant: "every new order screened by Northwind Pay",
      soThat: "stolen cards don't empty the stock",
    });
    expect(got.steps.map((s) => [s.id, s.repo, s.entry, s.at])).toContainEqual([
      "t2-1",
      "forge-web",
      "screen /checkout",
      "src/checkout.ts:20",
    ]);
    // A section one story leaves as none and another lists: the list.
    expect(Array.isArray(got.interfaces) && got.interfaces).toHaveLength(2);
    // Each story's non-functional words, by repo, once there are two stories.
    expect(got.nonFunctional?.auth).toBe(
      "forge-orders: POST /orders is called as today. The call to Northwind Pay sends the vendor's key from config, never logged. forge-web: The shopper is signed in as today.",
    );
    expect(got.dependencies).toEqual([
      "The V4 migration runs before forge-orders is released",
      "Story s1-place-order (forge-orders) lands before s2-checkout (forge-web)",
    ]);
    expect(got.context).toMatch(/^Story s1-place-order \(forge-orders\):/);
  });

  it("a step per place in the code (B-steps): each task's own code, the files it declares in, its new migration", () => {
    const got = convert();
    expect(got.steps.map((s) => [s.id, s.at, s.entry])).toEqual([
      ["t1-1", `${OC}:9`, "POST /orders"],
      ["t1-2", `${OC}:9`, "POST /orders"],
      ["t1-3", `${OC}:13`, "POST /orders"],
      // a file the facts cite for the write's columns: at its first cited line, on no entry
      ["f1", "src/main/resources/schema.sql:1", undefined],
      // a new file has no line yet
      ["f2", undefined, undefined],
    ]);
    expect(got.steps[3]!.what).toBe(
      "Task 1.3: the fields and columns change here: where table forge-orders-db.orders and its columns are",
    );
    expect(got.steps[4]!.what).toBe(
      "Task 1.3: the new migration V4__add_fraud_verdict.sql adds fraud_verdict to forge-orders-db.orders (a new file: V4__add_fraud_verdict.sql)",
    );
    // Each place is accepted by its tasks' criteria, cited where the place is.
    const on = (step: string) => got.criteria.filter((c) => c.step === step);
    expect(on("t1-3").map((c) => c.id)).toEqual(["t1-3-c1", "t1-3-c2"]);
    expect(on("f1").map((c) => [c.id, c.at, c.then])).toEqual([
      ["f1-t1-3-c1", "src/main/resources/schema.sql:1", on("t1-3")[0]!.then],
      ["f1-t1-3-c2", "src/main/resources/schema.sql:1", on("t1-3")[1]!.then],
    ]);
    expect(on("f1")[1]!.errors).toEqual([
      { ...on("t1-3")[1]!.errors[0]!, at: "src/main/resources/schema.sql:1" },
    ]);
    expect(on("f2").map((c) => [c.id, c.at])).toEqual([
      ["f2-t1-3-c1", undefined],
      ["f2-t1-3-c2", undefined],
    ]);
  });

  it("a file two stories declare in is one step; a new flow's uncited tasks are one step on its entry", () => {
    const cancel: DeltaStory = {
      id: "s2-cancel-order",
      repo: "forge-orders",
      flow: "forge-orders.cancel-order",
      name: "A client cancels an order",
      change: "new",
      entry: "DELETE /orders/{id}",
      tasks: [
        {
          id: "1.4",
          story: "s2-cancel-order",
          repo: "forge-orders",
          flow: "forge-orders.cancel-order",
          op: "add",
          position: 1,
          kind: "entry",
          title: "Add the entry step: OrderController.cancel receives the order id",
          what: "OrderController.cancel receives the order id",
          fields: ["id"],
          evidence: [],
        },
        {
          id: "1.5",
          story: "s2-cancel-order",
          repo: "forge-orders",
          flow: "forge-orders.cancel-order",
          op: "add",
          position: 2,
          kind: "write",
          title: "Add the write step: The order is marked cancelled",
          what: "The order is marked cancelled",
          fields: ["status"],
          evidence: [],
          files: [
            {
              file: "forge-orders:src/main/resources/schema.sql",
              lines: [3, 1],
              why: "where the orders' status column is",
            },
          ],
        },
      ],
    };
    const a = ANSWER();
    a.stories.push({
      id: "s2-cancel-order",
      title: "Cancel an order",
      asA: "client",
      iWant: "to cancel an order",
      soThat: "I'm not charged for it",
      tasks: [
        {
          id: "1.5",
          criteria: [
            {
              text: "Given an order, when DELETE /orders/{id} is called, then its status is cancelled",
              checks: ["status"],
              outcome: "success",
            },
          ],
        },
      ],
    });
    const got = convert([...STORIES, cancel], a);
    expect(got.steps.map((s) => [s.id, s.at, s.entry])).toEqual([
      ["t1-1", `${OC}:9`, "POST /orders"],
      ["t1-2", `${OC}:9`, "POST /orders"],
      ["t1-3", `${OC}:13`, "POST /orders"],
      ["f1", "src/main/resources/schema.sql:1", undefined],
      ["f2", undefined, undefined],
      ["new-s2-cancel-order", undefined, "DELETE /orders/{id}"],
    ]);
    expect(got.steps[3]!.what).toBe(
      "Tasks 1.3 and 1.5: the fields and columns change here: where table forge-orders-db.orders and its columns are; where the orders' status column is",
    );
    expect(got.steps[5]!.what).toBe(
      "Tasks 1.4 and 1.5: new code for DELETE /orders/{id}: OrderController.cancel receives the order id; The order is marked cancelled",
    );
    expect(
      got.criteria.filter((c) => c.id.endsWith("t1-5-c1")).map((c) => [c.id, c.step, c.entry]),
    ).toEqual([
      ["t1-5-c1", "new-s2-cancel-order", "DELETE /orders/{id}"],
      ["f1-t1-5-c1", "f1", "DELETE /orders/{id}"],
    ]);
  });

  it("says none for a section every story says none of, and leaves out one no story wrote", () => {
    const a = ANSWER();
    const s = a.stories[0]!;
    s.interfaces = { none: "no contract changes" };
    delete s.data;
    delete s.dependencies;
    const got = convert(STORIES, a);
    expect(got.interfaces).toEqual({ none: "no contract changes" });
    // The step adds a column, so the target flow's facts still make a data row.
    expect(Array.isArray(got.data) && got.data[0]).toMatchObject({
      column: "fraud_verdict",
      type: "varchar(20)",
      migration: V4,
      retention: "not said",
    });
    expect(got.dependencies).toBeUndefined();
    expect(got.notes).toMatch(/nullable of forge-orders-db\.orders\.fraud_verdict is not said/);
  });
});

const V4 = "V4__add_fraud_verdict.sql";
const OC = "src/main/java/forge/orders/OrderController.java";
