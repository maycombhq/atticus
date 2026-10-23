import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
