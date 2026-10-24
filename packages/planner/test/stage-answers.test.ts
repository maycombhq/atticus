import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { COVERS_FIELD_SPEC, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { listQuestions, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  architectureStage,
  EXPAND_AGENT,
  featureStage,
  GAP_RULE,
  PlannerError,
  repeatedFindings,
  stageEnd,
  storiesStage,
  READ_AGAIN_RULE,
} from "../src/index.js";

/**
 * A live run's stories stage on a chat app (the change pins a message), retold on Forge's
 * add-fraud-check change. S5: the stop named a file without the error, missed the problem the
 * drafts kept failing on, and spent a draft on a YAML slip. S6: a person who fixed the named file
 * was told "nothing in it reads". T1/U1: the stories stage drafted with no estate context. U3: the
 * covers-field judge raised one question per field per criterion.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const FIX = join(HERE, "fixtures/context-flows");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;
const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");

async function writeRecords(root: string, under: string, file: string): Promise<void> {
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, under, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

async function estateRoot(policy?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-answers-"));
  await mkdir(join(root, "org-pack/process"), { recursive: true });
  if (policy) await writeFile(join(root, "org-pack/process/change-policy.yaml"), policy);
  await writeRecords(root, "catalog/generated", SPECS_CATALOG);
  await writeRecords(root, "catalog/generated", join(STAGES, "catalog-extra.yaml"));
  await writeRecords(root, "knowledge/items", join(STAGES, "knowledge.yaml"));
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const dir = (root: string) => join(root, "openspec/changes", CHANGE);

/** Whether a request is the stage drafter's read-again of an answer that isn't YAML (S5). */
const isReadAgain = (req: AiRequest) => req.pack.prompt.includes(READ_AGAIN_RULE);

/**
 * A mock assistant: the expander adds nothing, critics find nothing, drafts in turn; a read-again
 * gets `again` (default: the draft it reads again, unchanged).
 */
function assistant(
  drafts: string[],
  o: { seen?: string[]; again?: string; reads?: string[] } = {},
) {
  let n = 0;
  let last = "";
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      if (isReadAgain(req)) {
        o.reads?.push(req.pack.prompt);
        return o.again ?? last;
      }
      o.seen?.push(req.pack.prompt);
      last = drafts[Math.min(n++, drafts.length - 1)]!;
      return last;
    },
    { now: () => NOW },
  );
}

async function architected(root: string): Promise<void> {
  const f = await featureStage(root, CHANGE, {
    runtime: assistant([fixture("feature-answer.yaml")]),
    now: NOW,
  });
  expect(f.state).toBe("done");
  const a = await architectureStage(root, CHANGE, {
    runtime: assistant([fixture("architecture-reads.yaml")]),
    now: NOW,
  });
  expect(a.state).toBe("done");
}

async function stopOf(p: Promise<unknown>): Promise<PlannerError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PlannerError);
  return e as PlannerError;
}

const STORIES = `stories:
  - id: s1-place-order
    title: Screen each order for fraud
    asA: shop owner
    iWant: every new order screened by Northwind Pay
    soThat: stolen cards don't empty the stock
    tasks:
      - id: "1.1"
        criteria:
          - text: "Given a new order, when it is placed, then sku, quantity and cardToken are sent to Northwind Pay and the verdict is read"
            checks: [sku, quantity, cardToken, verdict]
      - id: "1.2"
        criteria:
          - text: "Given a rejected verdict, when the order is placed, then the verdict refuses it with 422 and no stock is reserved"
            checks: [verdict]
      - id: "1.3"
        criteria:
          - text: "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
            checks: [sku, quantity, fraud_verdict]
`;

/** The live run's line 1: an endpoint with braces in a flow list, unquoted. */
const BAD_LINE = "relies_on_gaps: [PUT /orders/{orderId}/pin, Quillfeather Risk]";
const BAD = `${BAD_LINE}\n${STORIES}`;
const FIXED = `relies_on_gaps: ["PUT /orders/{orderId}/pin", "Quillfeather Risk"]\n${STORIES}`;

const NO_CRITERIA = STORIES.replace(
  `      - id: "1.3"
        criteria:
          - text: "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
            checks: [sku, quantity, fraud_verdict]
`,
  `      - id: "1.3"
        criteria: []
`,
);

describe("S5: an answer that isn't YAML", () => {
  it("goes back to the drafter once with its line and the quoting rule, without spending a draft", async () => {
    const root = await estateRoot();
    await architected(root);
    const reads: string[] = [];
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant([BAD], { reads, again: STORIES }),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(1);
    expect(r.iteration).toBe(1);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain(`line 1: ${BAD_LINE}`);
    expect(reads[0]).toContain("quote any value containing { } [ ] : or #");
  });

  it("stops naming the file that holds the error, with its line quoted; the valid answer is kept aside", async () => {
    const root = await estateRoot();
    await architected(root);
    const first = await storiesStage(root, CHANGE, { runtime: assistant([STORIES]), now: NOW });
    expect(first.state).toBe("done");
    const valid = await readFile(join(dir(root), "stage/stories-answer.yaml"), "utf8");
    const e = await stopOf(
      storiesStage(root, CHANGE, { runtime: assistant([BAD]), now: NOW, force: true }),
    );
    expect(e.message).toContain("The stories stage stopped after 4 drafts");
    expect(e.message).toContain(`line 1: ${BAD_LINE}`);
    expect(e.message).toContain(`in ${REL}/stage/stories-answer.yaml:1`);
    expect(e.message).toContain(
      `Fix ${REL}/stage/stories-answer.yaml, the answer that doesn't read, or tell your assistant how`,
    );
    expect(e.message).toContain(
      `The last answer that read is kept in ${REL}/stage/stories-answer.last-valid.yaml.`,
    );
    expect(e.message).not.toContain("Fix stage/stories-answer.yaml,");
    expect(await readFile(join(dir(root), "stage/stories-answer.yaml"), "utf8")).toBe(BAD);
    expect(await readFile(join(dir(root), "stage/stories-answer.last-valid.yaml"), "utf8")).toBe(
      valid,
    );
  });

  it("the stop says what the drafts kept failing on, by rule, with a count and one example", async () => {
    const root = await estateRoot();
    await architected(root);
    const e = await stopOf(
      storiesStage(root, CHANGE, {
        runtime: assistant([NO_CRITERIA, NO_CRITERIA, BAD, BAD, BAD]),
        now: NOW,
      }),
    );
    expect(e.message).toContain("What the drafts kept failing on:");
    // The rule the stop names above isn't counted again.
    expect(e.message).not.toContain("  - stage.format: in");
    expect(e.message).toContain(
      "  - stories.no-criteria: in 2 drafts (1 to 2), for example: Task 1.3 (Change the write step: The order is inserted with the screen's verdict) has no acceptance criteria.",
    );
  });

  it("the gap rule, which asks for relies_on_gaps, shows each name quoted, and the answer's reader accepts it", () => {
    // Why relies_on_gaps appeared "unrequested": the context's gap rule asks for it whenever
    // the step has gaps, and its flow-list example led to the unquoted braces.
    expect(GAP_RULE).toContain('relies_on_gaps:\n  - "<name, as it is listed>"');
    expect(GAP_RULE).toContain("in double quotes");
    expect(GAP_RULE).not.toContain("relies_on_gaps: [<name>, ...]");
  });

  it("repeatedFindings shows one criterion the judge refused", () => {
    const lines = repeatedFindings([
      {
        fingerprint: "aaaaaaaaaaaa",
        rule: "stories.check-not-in-criterion",
        target: "1.1:sku",
        message:
          'Task 1.1: the criterion "Given a new order, when it is placed, then the screen passes" doesn\'t check sku, quantity or cardToken.',
        blocking: true,
        source: "stage",
        seenIn: [1, 2, 3],
      },
      {
        fingerprint: "bbbbbbbbbbbb",
        rule: "stories.check-not-in-criterion",
        target: "1.3:sku",
        message: "Task 1.3: another criterion.",
        blocking: true,
        source: "stage",
        seenIn: [2, 3],
      },
    ]);
    expect(lines).toEqual([
      "What the drafts kept failing on:",
      '  - stories.check-not-in-criterion: in 3 drafts (1 to 3), 2 findings, for example: Task 1.1: the criterion "Given a new order, when it is placed, then the screen passes" doesn\'t check sku, quantity or cardToken.',
    ]);
  });
});

describe("S6: a person fixes the file the stop named, and the rerun takes it as their draft", () => {
  it("stories: stop, fix the named file, rerun: checked and done, with no draft", async () => {
    const root = await estateRoot();
    await architected(root);
    await stopOf(storiesStage(root, CHANGE, { runtime: assistant([BAD]), now: NOW }));
    const answer = join(dir(root), "stage/stories-answer.yaml");
    expect(await readFile(answer, "utf8")).toBe(BAD);
    await writeFile(answer, FIXED);
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, { runtime: assistant([BAD], { seen }), now: NOW });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(0);
    expect(seen).toEqual([]);
    expect(await readFile(join(dir(root), "stories/s1-place-order.md"), "utf8")).toContain(
      "the orders row holds sku, quantity and fraud_verdict",
    );
    const loop = parse(await readFile(join(dir(root), "stage/stories.yaml"), "utf8"));
    expect(loop.byPerson.at(-1)).toMatchObject({
      files: ["stage/stories-answer.yaml"],
      how: "checked",
    });
  });

  it("stories: a fix that still doesn't read stops with the file and line, never 'nothing in it reads'", async () => {
    const root = await estateRoot();
    await architected(root);
    await stopOf(storiesStage(root, CHANGE, { runtime: assistant([BAD]), now: NOW }));
    const answer = join(dir(root), "stage/stories-answer.yaml");
    await writeFile(answer, `${BAD_LINE}\n# still unquoted\n${STORIES}`);
    const e = await stopOf(storiesStage(root, CHANGE, { runtime: assistant([BAD]), now: NOW }));
    expect(e.message).not.toContain("nothing in it reads");
    expect(e.message).toContain(`${REL}/stage/stories-answer.yaml:1:`);
    expect(e.message).toContain(BAD_LINE);
  });

  it("stories: a deleted answer file can't be a draft; the stop says --force, not to fix it", async () => {
    const root = await estateRoot();
    await architected(root);
    const first = await storiesStage(root, CHANGE, { runtime: assistant([STORIES]), now: NOW });
    expect(first.state).toBe("done");
    await rm(join(dir(root), "stage/stories-answer.yaml"));
    const e = await stopOf(storiesStage(root, CHANGE, { runtime: assistant([BAD]), now: NOW }));
    expect(e.message).not.toContain("nothing in it reads");
    expect(e.message).toContain(`atticus plan stories ${CHANGE} --force`);
    expect(e.message).not.toContain("Fix them in your files");
  });

  it("architecture: stop, fix the copied answer, rerun: checked and done, the target flows written from it", async () => {
    const root = await estateRoot();
    const f = await featureStage(root, CHANGE, {
      runtime: assistant([fixture("feature-answer.yaml")]),
      now: NOW,
    });
    expect(f.state).toBe("done");
    const good = fixture("architecture-reads.yaml");
    const bad = good.replace(
      "why: The order is screened before stock is reserved.",
      "why: The order is screened: before stock is reserved.",
    );
    expect(bad).not.toBe(good);
    const e = await stopOf(
      architectureStage(root, CHANGE, { runtime: assistant([bad]), now: NOW }),
    );
    expect(e.message).toContain(`${REL}/stage/architecture-answer.yaml`);
    const copy = join(dir(root), "stage/architecture-answer.yaml");
    expect(await readFile(copy, "utf8")).toBe(bad);
    await writeFile(copy, good);
    const seen: string[] = [];
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([bad], { seen }),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(0);
    expect(seen).toEqual([]);
    expect(
      parse(await readFile(join(dir(root), "target-flows/forge-orders.place-order.yaml"), "utf8"))
        .steps,
    ).toHaveLength(3);
  });
});

describe("T1/U1: the stories stage drafts with the estate as context, on every path", () => {
  const records = (r: { context?: { picked: { kind: string }[] } }) =>
    (r.context?.picked ?? []).filter((p) => p.kind !== "ProcessDefinition");

  it("a first draft, --force, and a redraft from a person's edit each send estate records", async () => {
    const root = await estateRoot();
    await architected(root);
    const seen: string[] = [];
    const first = await storiesStage(root, CHANGE, {
      runtime: assistant([STORIES], { seen }),
      now: NOW,
    });
    expect(first.state).toBe("done");
    expect(records(first).length).toBeGreaterThan(0);
    expect(seen[0]).toContain('id="estate-index"');
    expect(seen[0]).toContain("forge-orders.place-order");

    const forced = await storiesStage(root, CHANGE, {
      runtime: assistant([STORIES], { seen }),
      now: NOW,
      force: true,
    });
    expect(records(forced).length).toBeGreaterThan(0);
    expect(seen[1]).toContain('id="estate-index"');

    const answer = join(dir(root), "stage/stories-answer.yaml");
    await writeFile(answer, (await readFile(answer, "utf8")).replace("shop owner", "shop manager"));
    const edited = await storiesStage(root, CHANGE, {
      runtime: assistant([STORIES], { seen }),
      now: NOW,
      force: true,
    });
    expect(records(edited).length).toBeGreaterThan(0);
    expect(seen[2]).toContain('id="estate-index"');
    expect(seen[2]).toContain('id="current-draft"');
  });
});

describe("U3: the covers-field judge asks one question per criterion, after one redraft", () => {
  /** The live run's kind of criterion: it names the event and none of the fields it claims. */
  const VAGUE = STORIES.replace(
    "then sku, quantity and cardToken are sent to Northwind Pay and the verdict is read",
    "then the screen passes",
  );
  const WHY =
    "It says the screen passes, not what the fields hold or what happens when one doesn't match.";
  /** A runtime that calls a model directly: the drafter writes VAGUE, the judge says no to every claim. */
  class Direct extends MockRuntime {
    override readonly kind = "model" as const;
    constructor(seen: string[], draft = VAGUE, quote = "then the screen passes") {
      super(
        (req: AiRequest) => {
          if (req.agent.id.endsWith("-critic")) return "findings: []";
          if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
          if (req.agent.id === "judge") {
            if (!req.pack.prompt.includes(COVERS_FIELD_SPEC.ask)) return "judgments: []\n";
            const n = (req.pack.prompt.match(/^item \d+:/gm) ?? []).length;
            return `judgments:\n${Array.from(
              { length: n },
              (_, i) =>
                `  - item: ${i + 1}\n    verdict: no\n    quotes: [{ of: criterion, text: "${quote}" }]\n    why: ${WHY}\n`,
            ).join("")}`;
          }
          seen.push(req.pack.prompt);
          return draft;
        },
        { now: () => NOW },
      );
    }
  }

  it("one question for the criterion with the judge's reason and three options, at the criterion's line, raised after the drafter had it once", async () => {
    const root = await estateRoot();
    await architected(root);
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, { runtime: new Direct(seen), now: NOW });
    expect(r.state).toBe("questions");
    // Three drafts in a row had it; it went back to the drafter once more with the reason.
    expect(seen).toHaveLength(4);
    expect(seen[3]).toContain(WHY);
    const qs = r.questions.filter((q) => q.question.includes("then the screen passes"));
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.question).toBe(
      `Does the criterion "Given a new order, when it is placed, then the screen passes" of task 1.1 check sku, quantity, cardToken and verdict: does its outcome depend on their values? A judge read it and says no, quoting "then the screen passes": ${WHY}`,
    );
    expect(q.options.map((o) => o.label)).toEqual([
      "yes, it checks them",
      "no: change the criterion",
      "not needed",
    ]);
    const story = (await readFile(join(dir(root), "stories/s1-place-order.md"), "utf8")).split(
      /\r?\n/,
    );
    const line = story.findIndex((l) => l.includes("then the screen passes")) + 1;
    expect(line).toBeGreaterThan(0);
    expect(q.evidence).toEqual([`${REL}/stories/s1-place-order.md:${line}`]);
  });

  it("the questions per stop are capped by the change policy, and the stop says how many more wait", async () => {
    const root = await estateRoot("schemaVersion: 1\nquestionsPerStop: 1\n");
    await architected(root);
    // Two vague criteria: tasks 1.1 and 1.3.
    const TWO = VAGUE.replace(
      "then the orders row holds sku, quantity and fraud_verdict",
      "then the order is saved",
    );
    const r = await storiesStage(root, CHANGE, {
      runtime: new Direct([], TWO, "when it is"),
      now: NOW,
    });
    expect(r.state).toBe("questions");
    expect(r.questions).toHaveLength(1);
    expect(r.moreQuestions).toBe(1);
    expect(stageEnd(r, `atticus plan stories ${CHANGE}`).join("\n")).toContain(
      "1 more question waits; it is asked once these are answered.",
    );
    expect((await listQuestions(root, { state: "open" })).questions).toHaveLength(1);
  });
});
