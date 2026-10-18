import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { formatGrade, gradeDialect } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, "../../../fixtures/forge-dialect-eval");
const REFERENCE = join(HERE, "reference/forge-messaging.yaml");

type Doc = {
  rules: { id: string; emit: { id?: string; fields: Record<string, unknown> } }[];
  tests: { fixture?: string; [k: string]: unknown }[];
  [k: string]: unknown;
};

/** The reference dialect with a change applied, written to a temp folder (fixture paths made absolute). */
async function variant(change: (d: Doc) => void): Promise<string> {
  const d = parse(readFileSync(REFERENCE, "utf8")) as Doc;
  for (const t of d.tests) if (t.fixture) t.fixture = resolve(dirname(REFERENCE), t.fixture);
  change(d);
  const dir = await mkdtemp(join(tmpdir(), "atticus-grade-"));
  const file = join(dir, "forge-messaging.yaml");
  await writeFile(file, stringify(d));
  return file;
}

describe("gradeDialect", () => {
  it("passes the reference solution with full precision and recall", async () => {
    const g = await gradeDialect(REFERENCE, EVAL);
    expect(g.problems).toEqual([]);
    expect(g.tests.every((t) => t.passed)).toBe(true);
    expect(g.repos.map((r) => [r.path, r.expected, r.matched, r.produced])).toEqual([
      ["repos/order-intake", 6, 6, 6],
      ["repos/inventory-sync", 6, 6, 6],
      ["repos/notify-worker", 4, 4, 4],
      ["holdout/billing-relay", 5, 5, 5],
    ]);
    expect(g).toMatchObject({ pass: true, expected: 21, matched: 21, precision: 1, recall: 1 });
    expect(formatGrade(g).at(-1)).toBe(
      "PASS: 21 of 21 expected records, precision 1.00, recall 1.00",
    );
  });

  it("fails a dialect with wrong ids", async () => {
    const file = await variant((d) => {
      d.rules.find((r) => r.id === "queue-consumer")!.emit.id =
        "${yaml:messaging.yaml#app}.queue.${attr.queue}";
      d.tests = d.tests.filter((t) => !t.fixture); // its own fixture test would catch it first
    });
    const g = await gradeDialect(file, EVAL);
    expect(g.pass).toBe(false);
    expect(g.problems).toEqual([]);
    // An upper-case id is not a valid record id, so the records are rejected outright.
    expect(g.repos[0]!.missing).toEqual(["Endpoint/order-intake.queue.orders.in"]);
    expect(g.repos[0]!.rejected).toHaveLength(1);
    expect(g.recall).toBeCloseTo(17 / 21);
  });

  it("fails a dialect whose field values are wrong, naming the field", async () => {
    const file = await variant((d) => {
      d.rules.find((r) => r.id === "relay-call")!.emit.fields.method = "${attr.verb}";
      d.tests = d.tests.filter(
        (t) => !t.fixture && t.name !== "lower-case verbs and colon path parameters",
      );
    });
    const g = await gradeDialect(file, EVAL);
    expect(g.pass).toBe(false);
    // A lower-case verb changes nothing in the derived id (it is upper-cased there) but the field is wrong.
    expect(g.repos[1]!.wrong).toEqual([
      { record: "Interface/if-a335408ee3c9f01d", field: "method", expected: "GET", got: "get" },
    ]);
    expect(g.repos[3]!.wrong).toEqual([
      { record: "Interface/if-546fab3ebf596ab7", field: "method", expected: "POST", got: "post" },
    ]);
    expect(g.matched).toBe(19);
  });

  it("fails a dialect without tests, or whose tests fail or expect nothing", async () => {
    const none = await gradeDialect(
      await variant((d) => {
        d.tests = [];
      }),
      EVAL,
    );
    expect(none.pass).toBe(false);
    expect(none.problems).toContain("tests: every dialect ships at least one test");

    const failing = await gradeDialect(
      await variant((d) => {
        d.tests = [
          {
            name: "wrong",
            files: { "messaging.yaml": "app: a\n" },
            expect: [{ kind: "Endpoint", id: "a.queue.x" }],
          },
        ];
      }),
      EVAL,
    );
    expect(failing.pass).toBe(false);
    expect(failing.tests).toEqual([
      { name: "wrong", passed: false, failures: ["expected Endpoint a.queue.x, got nothing"] },
    ]);

    const empty = await gradeDialect(
      await variant((d) => {
        d.tests = [{ name: "nothing", files: { a: "" }, expect: [] }];
      }),
      EVAL,
    );
    expect(empty.pass).toBe(false);
    expect(empty.problems).toEqual([
      "the dialect's tests expect no records; at least one test must list the records it expects",
    ]);
  });

  it("fails a dialect that produces extra records of the expected kinds", async () => {
    const file = await variant((d) => {
      d.rules.push({
        id: "queue-as-loose-end",
        description: "Wrongly also treats a queue as a loose end.",
        match: {
          annotation: "QueueConsumer",
          target: "method",
          files: ["src/main/java/**/*.java"],
        },
        emit: {
          kind: "Unresolved",
          id: "${yaml:messaging.yaml#app}.queue-in.${attr.queue | lower}",
          fields: { unresolvedKind: "mq", raw: "${attr.queue}" },
        },
        confidence: "inferred",
      } as unknown as Doc["rules"][number]);
    });
    const g = await gradeDialect(file, EVAL);
    expect(g.pass).toBe(false);
    expect(g.repos[0]!.extra).toEqual(["Unresolved/order-intake.queue-in.orders.in"]);
    expect(g.recall).toBe(1);
    expect(g.precision).toBeCloseTo(21 / 25);
  });

  it("fails a dialect that writes the eval repos' values into its rules (the holdout repo catches it)", async () => {
    const file = await variant((d) => {
      const timeout = d.rules.find((r) => r.id === "relay-timeout")!;
      d.rules = d.rules.filter((r) => r !== timeout);
      for (const client of ["inventory-api", "warehouse-gateway"]) {
        const r = structuredClone(timeout) as unknown as Doc["rules"][number] & {
          match: { configKey: string };
        };
        r.id = `${client}-timeout`;
        r.match.configKey = `relay.clients.${client}.timeout`;
        d.rules.push(r);
      }
      d.tests = d.tests.filter((t) => t.name !== "lower-case verbs and colon path parameters");
    });
    const g = await gradeDialect(file, EVAL);
    expect(g.tests.every((t) => t.passed)).toBe(true);
    expect(g.repos.map((r) => r.missing)).toEqual([
      [],
      [],
      [],
      ["Setting/billing-relay.ledger-api.timeout"],
    ]);
    expect(g.pass).toBe(false);
  });

  it("reports a dialect that doesn't load, or has the wrong name", async () => {
    const bad = await gradeDialect(
      await variant((d) => {
        d.rules[0]!.emit.fields.nope = "x";
      }),
      EVAL,
    );
    expect(bad.pass).toBe(false);
    expect(bad.problems).toEqual([
      "rules.0.emit.fields.nope: Endpoint has no field nope in contract C1",
    ]);

    const renamed = await gradeDialect(
      await variant((d) => {
        d.name = "forge-msg";
      }),
      EVAL,
    );
    expect(renamed.problems).toContain(
      "the task asks for a dialect named forge-messaging, not forge-msg",
    );
  });
});
