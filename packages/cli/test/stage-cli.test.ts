import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { stageCli } from "../src/stage-commands.js";

/**
 * The change stages as commands (ADR 0087): `atticus change feature`, with --handoff for
 * Copilot Chat, and `atticus bench design`. The assistant's part is a mock or the test
 * writing the result file.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const BENCH = join(dirname(fileURLToPath(import.meta.url)), "../../../bench");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIXTURES, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
`;

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus change feature", () => {
  it("loops to done and prints the PR to open", async () => {
    const root = await estate();
    const o = io();
    const mock = new MockRuntime(
      (req) => (req.agent.id.endsWith("-critic") ? "findings: []" : PLACED),
      { now: () => NOW },
    );
    const code = await stageCli(root, ["change", "feature", CHANGE], {}, o.io, {
      runtime: mock,
      now: NOW,
    });
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    expect(o.out).toContain(
      "The feature stage is done after 1 draft (1 draft this run): nothing blocking is open and no question is waiting.",
    );
    expect(o.out).toContain(
      "Open the stage's pull request for a person to approve: atticus change handoff add-fraud-check --approve",
    );
  });

  it("says what context it selected; --whole-context sends the whole estate; --context-tokens is checked (ADR 0107)", async () => {
    const root = await estate();
    const prompts: string[] = [];
    const mock = () =>
      new MockRuntime(
        (req) => {
          if (req.agent.id.endsWith("-critic")) return "findings: []";
          prompts.push(req.pack.prompt);
          return PLACED;
        },
        { now: () => NOW },
      );
    const a = io();
    expect(
      await stageCli(root, ["change", "feature", CHANGE], {}, a.io, { runtime: mock(), now: NOW }),
    ).toBe(0);
    expect(a.out.find((l) => l.startsWith("Context: "))).toMatch(
      /^Context: \d+ records selected from the index \(\d+ in full\), \d+ of \d+ tokens/,
    );
    expect(prompts[0]).toContain('origin="atticus change feature (context engine)"');

    const b = io();
    expect(
      await stageCli(
        root,
        ["change", "feature", CHANGE],
        { "whole-context": true, force: true },
        b.io,
        { runtime: mock(), now: NOW },
      ),
    ).toBe(0);
    expect(b.out.some((l) => l.startsWith("Context: "))).toBe(false);
    expect(prompts.at(-1)).toContain('origin="atticus change feature (deterministic)"');

    const c = io();
    expect(
      await stageCli(root, ["change", "feature", CHANGE], { "context-tokens": "12" }, c.io, {
        runtime: mock(),
        now: NOW,
      }),
    ).toBe(2);
    expect(c.err).toEqual([
      "--context-tokens is a whole number of 100 or more: the room for the context.",
    ]);
  });

  it("with --handoff prints only the prompt, the result file and the commands that finish it", async () => {
    const root = await estate();
    const out: string[] = [];
    const code = await main(
      ["change", "feature", CHANGE, "--handoff", "--root", root],
      { out: (l) => out.push(l), err: () => {} },
      { quiet: true },
    );
    expect(code).toBe(0);
    expect(out).toHaveLength(5);
    expect(out[0]).toMatch(/^Prompt: \.runs\/add-fraud-check\/run-[0-9a-z-]+\/prompt\.md$/);
    expect(out[1]).toMatch(
      /^Result file: \.runs\/add-fraud-check\/run-[0-9a-z-]+\/feature-answer\.yaml$/,
    );
    expect(out[4]).toMatch(
      /^ {2}atticus change feature add-fraud-check --root .+ --handoff --resume run-/,
    );
  });
});

describe("a stage run again while its hand-off waits (--handoff --json)", () => {
  it("hands the same run off again, so a runner that lost its place carries on", async () => {
    const root = await estate();
    const step = async () => {
      const out: string[] = [];
      await main(
        ["change", "feature", CHANGE, "--handoff", "--json", "--root", root],
        { out: (l) => out.push(l), err: () => {} },
        { quiet: true },
      );
      return JSON.parse(out.join("\n")) as {
        state: string;
        runId?: string;
        stillWaiting?: boolean;
      };
    };
    const first = await step();
    expect(first.state).toBe("handoff");
    const again = await step();
    expect(again).toMatchObject({ state: "handoff", runId: first.runId, stillWaiting: true });
  });
});

describe("atticus change feature --handoff --json with the critic's AI lenses (ADR 0115)", () => {
  it("offers each lens after the draft, one hand-off at a time, and ends done", async () => {
    const root = await estate();
    await cp(join(FIXTURES, "stages/lenses/checklists"), join(root, "org-pack/checklists"), {
      recursive: true,
    });
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        argv,
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out, err };
    };
    const json = (out: string[]) =>
      JSON.parse(out.join("\n")) as {
        state: string;
        runId: string;
        lens?: string;
        resultFile: string;
        promptFile: string;
        doneArgs: string[];
        resumeArgs: string[];
      };
    const answer = async (h: ReturnType<typeof json>, text: string) => {
      await writeFile(join(root, h.resultFile), text);
      const done = await run(h.doneArgs);
      expect(done.code).toBe(0);
      return json((await run(h.resumeArgs)).out);
    };

    const draft = json(
      (await run(["change", "feature", CHANGE, "--handoff", "--json", "--root", root])).out,
    );
    expect(draft.state).toBe("handoff");
    expect(draft.lens).toBeUndefined();
    expect(draft.resultFile).toMatch(/feature-answer\.yaml$/);

    // The draft passes the rules: the business lens is offered, then the architecture lens.
    const business = await answer(draft, PLACED);
    expect(business).toMatchObject({ state: "handoff", lens: "business" });
    expect(business.resultFile).toMatch(/\/findings-business\.yaml$/);
    expect(business.resumeArgs).toEqual([
      "change",
      "feature",
      CHANGE,
      "--root",
      root,
      "--handoff",
      "--json",
      "--resume",
      business.runId,
    ]);
    expect(await readFile(join(root, business.promptFile), "utf8")).toContain(
      "Review the draft against the estate and the brief, including what the draft left out",
    );
    const architecture = await answer(business, "findings: []\n");
    expect(architecture).toMatchObject({ state: "handoff", lens: "architecture" });
    expect(architecture.runId).not.toBe(business.runId);

    // Every lens is in and nothing blocks: the stage is done.
    const end = await answer(architecture, "findings: []\n");
    expect(end.state).toBe("done");
    const round = parse(
      await readFile(
        join(root, "openspec/changes", CHANGE, "review/define/1/meta/round.yaml"),
        "utf8",
      ),
    ) as { lenses: { lens: string; state: string }[] };
    expect(round.lenses.map((l) => [l.lens, l.state])).toEqual([
      ["business", "ran"],
      ["architecture", "ran"],
    ]);
  });
});

describe("the starter review on a metarepo atticus init made (ADR 0120)", () => {
  it("hands off the starter review's lenses after a draft that passes the rules", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-starter-review-"));
    const root = join(base, "forge-meta");
    const quiet = { out: () => undefined, err: () => undefined };
    expect(
      await main(["init", root, "--platform", "forge", "--owner", "pat"], quiet, { quiet: true }),
    ).toBe(0);
    // The estate and the change, laid over what init wrote.
    const from = await estate();
    await cp(join(from, "catalog"), join(root, "catalog"), { recursive: true });
    await cp(join(from, "specs"), join(root, "specs"), { recursive: true });
    await cp(join(from, "openspec/changes"), join(root, "openspec/changes"), { recursive: true });

    const run = async (argv: string[]) => {
      const out: string[] = [];
      const code = await main(argv, { out: (l) => out.push(l), err: () => {} }, { quiet: true });
      expect(code, argv.join(" ")).toBe(0);
      return JSON.parse(out.join("\n")) as {
        state: string;
        runId: string;
        lens?: string;
        resultFile: string;
        promptFile: string;
        doneArgs: string[];
        resumeArgs: string[];
      };
    };
    const finish = async (argv: string[]) =>
      expect(await main(argv, quiet, { quiet: true }), argv.join(" ")).toBe(0);
    let h = await run(["change", "feature", CHANGE, "--handoff", "--json", "--root", root]);
    expect(h.lens).toBeUndefined();
    await writeFile(join(root, h.resultFile), PLACED);
    await finish(h.doneArgs);
    h = await run(h.resumeArgs);

    // No checklist was added by hand: the starter review's lenses come one at a time.
    const offered: string[] = [];
    while (h.state === "handoff" && h.lens) {
      offered.push(h.lens);
      const prompt = await readFile(join(root, h.promptFile), "utf8");
      if (h.lens === "business") expect(prompt).toContain("review.brief-outcomes-placed");
      if (h.lens === "architecture") {
        expect(prompt).toContain("review.changed-flow-not-read");
        expect(prompt).toContain("review.assumed-capability-named");
      }
      await writeFile(join(root, h.resultFile), "findings: []\n");
      await finish(h.doneArgs);
      h = await run(h.resumeArgs);
    }
    expect(offered).toEqual(["business", "architecture"]);
    expect(h.state).toBe("done");
    const round = parse(
      await readFile(
        join(root, "openspec/changes", CHANGE, "review/define/1/meta/round.yaml"),
        "utf8",
      ),
    ) as { lenses: { lens: string; state: string; rules: string[] }[] };
    expect(round.lenses.map((l) => [l.lens, l.state, l.rules])).toEqual([
      ["business", "ran", ["review.brief-outcomes-placed"]],
      ["architecture", "ran", ["review.changed-flow-not-read", "review.assumed-capability-named"]],
    ]);
    // init, then a draft and two lenses, each a command of its own.
  }, 180_000);
});

describe("a stage's --handoff --json offers its own run, named as data (M5, M6)", () => {
  const run = async (root: string, argv: string[]) => {
    const out: string[] = [];
    const code = await main(argv, { out: (l) => out.push(l), err: () => {} }, { quiet: true });
    // handoff done prints sentences; the steps with --json print one object.
    const text = out.join("\n");
    return {
      code,
      j: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  };

  it("never offers another change's run, though it was handed off at the same time", async () => {
    const root = await estate();
    await writeFile(
      join(root, "openspec/changes/bulk-orders/brief.md"),
      "# Bulk orders\n\nA shop owner places many orders at once.\n",
    );
    const mine = await run(root, [
      "change",
      "feature",
      CHANGE,
      "--handoff",
      "--json",
      "--root",
      root,
    ]);
    // Another change's step hands off while this one waits.
    await run(root, [
      "change",
      "feature",
      "bulk-orders",
      "--force",
      "--handoff",
      "--json",
      "--root",
      root,
    ]);
    const again = await run(root, [
      "change",
      "feature",
      CHANGE,
      "--handoff",
      "--json",
      "--root",
      root,
    ]);
    expect(again.j).toMatchObject({ state: "handoff", runId: mine.j.runId, stillWaiting: true });
  });

  it("offers a lens again, still waiting, when its answer failed the check", async () => {
    const root = await estate();
    await cp(join(FIXTURES, "stages/lenses/checklists"), join(root, "org-pack/checklists"), {
      recursive: true,
    });
    const draft = (
      await run(root, ["change", "feature", CHANGE, "--handoff", "--json", "--root", root])
    ).j;
    await writeFile(join(root, draft.resultFile as string), PLACED);
    await run(root, draft.doneArgs as string[]);
    const lens = (await run(root, draft.resumeArgs as string[])).j;
    expect(lens).toMatchObject({ state: "handoff", lens: "business" });
    // Copilot answered with nothing: the check fails it.
    await writeFile(join(root, lens.resultFile as string), "");
    expect((await run(root, lens.doneArgs as string[])).code).toBe(1);
    const again = (await run(root, lens.resumeArgs as string[])).j;
    expect(again).toMatchObject({
      state: "handoff",
      runId: lens.runId,
      lens: "business",
      stillWaiting: true,
    });
  });
});

describe("atticus bench design", () => {
  it("scores the bench's design with the assistant's mapping", async () => {
    const cache = await mkdtemp(join(tmpdir(), "atticus-design-bench-"));
    const o = io();
    const mock = new MockRuntime(() => "design:\n  screens: []\n", { now: () => NOW });
    const code = await stageCli(process.cwd(), ["bench", "design"], { bench: BENCH, cache }, o.io, {
      runtime: mock,
      now: NOW,
    });
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    expect(o.out[0]).toMatch(
      /^Design bench: .+ \(5 screens, \d+ fields and actions read; 3 drafts\)$/,
    );
    expect(o.out).toContain(
      "Screens: 0 of 5 found (missed: owner-pets, pet-vaccinations, add-vaccination, vaccination-saved, vaccinations-empty-error)",
    );
  });
});
