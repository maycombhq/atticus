import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDefinition,
  withPlanListener,
  withRunIo,
  type BudgetLimit,
  type RunIo,
} from "@maycombhq/core";
import {
  budgetRuntime,
  buildContextPack,
  MockRuntime,
  planLine,
  planRun,
  registerRunPreflight,
  usageFileOf,
  usedIn,
  type AiRequest,
} from "../src/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/budget");
const NOW = new Date("2026-11-24T12:00:00.000Z");
/** The fixture's runtime.yaml limits. */
const LIMITS: BudgetLimit[] = [
  { per: "run", sessions: 6 },
  { per: "day", sessions: 10 },
  { per: "month", tokens: 100000 },
];

const reader = AgentDefinition.parse({
  schemaVersion: 1,
  id: "repo-reader",
  role: "architect",
  description: "Reads a repo's code into facts.",
  inputs: ["repo-code"],
  outputArtifact: "data",
  tokenBudget: 5000,
  allowedRuntimes: ["mock", "model"],
});
const request = (): AiRequest => ({
  change: "map-forge-orders",
  agent: reader,
  pack: buildContextPack({
    change: "map-forge-orders",
    agent: reader.id,
    budget: 5000,
    levels: ["internal"],
    maxClassification: "internal",
    now: NOW,
    sources: [
      {
        id: "i",
        kind: "instruction",
        origin: "x",
        text: "Read the files.",
        classification: "internal",
        trusted: true,
      },
    ],
  }),
  outputPath: "facts.jsonl",
});

/** A metarepo whose person has the fixture's use on file. */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-budget-"));
  await mkdir(dirname(usageFileOf(root)), { recursive: true });
  await copyFile(join(FIXTURE, "usage.jsonl"), usageFileOf(root));
  return root;
}

/** A mock runtime under the budget, counting the requests it answers. */
function mock(root: string, limits: BudgetLimit[] = LIMITS) {
  const asked: string[] = [];
  const rt = budgetRuntime(
    new MockRuntime((r) => (asked.push(r.change), "{}"), { now: () => NOW }),
    { root, limits, now: () => NOW },
  );
  return { rt, asked };
}

const io = (o: Partial<RunIo> = {}) => {
  const said: string[] = [];
  return { said, io: { say: (l: string) => said.push(l), ...o } };
};

afterEach(() => registerRunPreflight(undefined));

describe("a budget, said before it is spent (ADR 0210 part 5)", () => {
  it("says what a run plans, and the limits with what is used, by UTC day and month", async () => {
    const root = await metarepo();
    expect(await usedIn(root, "day", NOW)).toEqual({ sessions: 7, tokens: 30000 });
    expect(await usedIn(root, "month", NOW)).toEqual({ sessions: 10, tokens: 60000 });
    expect(await usedIn(root, "run", NOW)).toEqual({ sessions: 0, tokens: 0 });
    const plan = { what: "The read of forge-orders", sessions: 2, tokens: 5000 };
    expect(planLine(plan, [], {})).toBe(
      "Budget: The read of forge-orders plans 2 sessions and about 5,000 tokens; no limit is set (budgets.limits in runtime.yaml).",
    );
    expect(
      planLine(plan, LIMITS, {
        day: { sessions: 7, tokens: 30000 },
        month: { sessions: 10, tokens: 60000 },
      }),
    ).toBe(
      "Budget: The read of forge-orders plans 2 sessions and about 5,000 tokens; limits: 6 sessions a run, 10 sessions a day (7 used), 100,000 tokens a month (60,000 used).",
    );
  });

  it("says the line first, then runs, and counts what each request spent on this machine", async () => {
    const root = await metarepo();
    const { rt, asked } = mock(root);
    const { said, io: given } = io();
    const heard: string[] = [];
    await withPlanListener(
      (l) => heard.push(l),
      () =>
        withRunIo(given, async () => {
          expect(
            await planRun(rt, { what: "The read", sessions: 2, tokens: 5000 }),
          ).toBeUndefined();
          for (let i = 0; i < 2; i++) await rt.run((await rt.prepare(request())).runId);
        }),
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Budget: The read plans 2 sessions/);
    expect(heard).toEqual(said);
    expect(asked).toHaveLength(2);
    const day = await usedIn(root, "day", NOW);
    expect(day.sessions).toBe(9);
    expect(day.tokens).toBeGreaterThan(30000);
    const lines = (await readFile(usageFileOf(root), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(6);
  });

  it("a run that plans nothing itself says one session of its first prompt", async () => {
    const root = await metarepo();
    const { rt } = mock(root, []);
    const { said, io: given } = io();
    await withRunIo(given, async () => rt.run((await rt.prepare(request())).runId));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(
      /^Budget: repo-reader plans 1 session and about \d+ tokens; no limit is set/,
    );
  });

  it("over the budget, asks at a terminal: yes runs, anything else sends nothing", async () => {
    const plan = { what: "The read", sessions: 4, tokens: 5000 };
    for (const [answer, runs] of [
      ["y", true],
      ["", false],
    ] as const) {
      const root = await metarepo();
      const { rt, asked } = mock(root);
      const questions: string[] = [];
      const { said, io: given } = io({ ask: async (q) => (questions.push(q), answer) });
      const stopped = await withRunIo(given, async () => {
        const r = await planRun(rt, plan);
        if (!r) await rt.run((await rt.prepare(request())).runId);
        return r;
      });
      expect(questions).toEqual([
        "This run would pass 10 sessions a day: 7 used and 4 planned. Run it anyway? [y/N]",
      ]);
      expect(asked.length > 0).toBe(runs);
      expect(stopped).toBe(runs ? undefined : "Nothing was sent.");
      expect(said[0]).toMatch(/^Budget: /);
    }
  });

  it("unattended (CI, no terminal, an assistant), stops before it starts unless --yes", async () => {
    const plan = { what: "The read", sessions: 1, tokens: 50000 };
    const root = await metarepo();
    const { rt, asked } = mock(root);
    const { io: given } = io();
    const stopped = await withRunIo(given, () => planRun(rt, plan));
    expect(stopped).toBe(
      "This run would pass 100,000 tokens a month: 60,000 used and 50,000 planned. Nothing was sent. Confirm it at a terminal, run it with --yes, or raise budgets.limits in org-pack/runtime.yaml.",
    );
    // A request after a stop is refused too: nothing goes past a stopped plan.
    await expect(rt.run((await rt.prepare(request())).runId)).rejects.toThrow(/Nothing was sent/);
    expect(asked).toEqual([]);
    const yes = mock(root);
    expect(
      await withRunIo({ say: () => undefined, yes: true }, () => planRun(yes.rt, plan)),
    ).toBeUndefined();
  });

  it("a run whose result is written checks it can be before any request (a lock held)", async () => {
    const root = await metarepo();
    const { rt, asked } = mock(root);
    registerRunPreflight(async (at) =>
      at === root
        ? "Another catalog build is running (process 41 on forge-ci). Wait for it to finish."
        : undefined,
    );
    const { said, io: given } = io();
    const stopped = await withRunIo(given, () =>
      planRun(rt, { what: "The read", sessions: 1, tokens: 10, writes: true }),
    );
    expect(stopped).toBe(
      "Another catalog build is running (process 41 on forge-ci). Wait for it to finish. Nothing was sent.",
    );
    expect(said).toHaveLength(1);
    expect(asked).toEqual([]);
    // A run that writes nothing isn't held up by it.
    expect(
      await planRun(mock(root).rt, { what: "An answer", sessions: 1, tokens: 10 }),
    ).toBeUndefined();
  });
});
