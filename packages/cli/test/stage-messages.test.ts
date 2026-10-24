import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime, MockRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import type { GateStatus } from "@maycombhq/naysayer";
import { EXPAND_AGENT, featureStage } from "@maycombhq/planner";
import { stageCheck, stageCli, wroteLines } from "../src/stage-commands.js";
import { handoffDone } from "../src/workspace-commands.js";
import { critic, statusLine } from "../src/critic-commands.js";
import { contextLines } from "../src/context-flags.js";

/**
 * What a live run found in the words after a stage (ADR 0087 addendum): "Wrote … (all 7)" when
 * none changed; change status saying a person decides for one open gap while the stage said
 * nothing blocking was open; and the checking round said two ways.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-words-"));
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

const mock = () =>
  new MockRuntime(
    (req) =>
      req.agent.id.endsWith("-critic")
        ? "findings: []"
        : req.agent.id === EXPAND_AGENT
          ? "terms: []\nnames: []\n"
          : PLACED,
    { now: () => NOW },
  );

describe("a stage's write that changes nothing says so", () => {
  it("names what it wrote on the first run, and that nothing changed when it writes the same again", async () => {
    const root = await estate();
    const first = io();
    expect(
      await stageCli(root, ["change", "feature", CHANGE], {}, first.io, {
        runtime: mock(),
        now: NOW,
      }),
    ).toBe(0);
    expect(first.out.some((l) => l.startsWith("Wrote ") && l.includes("feature.yaml"))).toBe(true);
    const again = io();
    expect(
      await stageCli(root, ["change", "feature", CHANGE], { force: true }, again.io, {
        runtime: mock(),
        now: NOW,
      }),
    ).toBe(0);
    expect(again.out.some((l) => l.startsWith("Wrote "))).toBe(false);
    expect(again.out).toContain("Kept the feature placement: nothing changed.");
  });

  it("wroteLines: kept your target flows when a person's files were written back unchanged", () => {
    expect(
      wroteLines({
        stage: "architecture",
        files: ["target-flows/a.yaml", "design.md"],
        changed: [],
        byPerson: true,
      }),
    ).toEqual(["Kept your target flows: nothing changed."]);
    expect(
      wroteLines({
        stage: "architecture",
        files: ["target-flows/a.yaml", "design.md"],
        changed: ["design.md"],
      }),
    ).toEqual(["Wrote design.md (target-flows/a.yaml is as it was)."]);
  });
});

const status = (o: Partial<GateStatus>): GateStatus => ({
  gate: "design",
  round: 3,
  maxRounds: 2,
  open: { blocking: 0, gaps: 1, risks: 0, ideas: 0 },
  total: { blocking: 0, gaps: 1, risks: 0, ideas: 0 },
  mayProceed: false,
  humanDecides: false,
  checkRound: false,
  checkRoundsRun: 1,
  waiting: [],
  reasons: ["The gap g1 is open."],
  findings: [],
  ...o,
});

describe("change status and the stage say the same about a gate", () => {
  it("an open gap with nothing blocking waits on its owner, never 'a person decides now'", () => {
    const line = statusLine(status({}));
    expect(line).not.toContain("a person decides now");
    expect(line).toContain(
      "1 open gap waits on its owner, so the design hand-off waits until it is answered",
    );
  });

  it("a checking round due is stated as the rule a stop states it with", () => {
    expect(
      statusLine(
        status({
          open: { blocking: 0, gaps: 0, risks: 0, ideas: 0 },
          mayProceed: true,
          checkRound: true,
          reasons: [],
        }),
      ),
    ).toBe(
      "The design gate may proceed: nothing blocking is open. Its 2 critic rounds and the checking round are used, but a person acted since round 3, so one more checking round is due (atticus critic <change> --gate design).",
    );
  });
});

describe("a hand-off draft checks itself in handoff done, the way a linter does (W3a)", () => {
  const BAD = PLACED.replace("forge-orders.place-order", "forge-orders.no-such-flow");

  it("lists the stage's problems and keeps the run open; a fixed file is handed in; after the limit it is handed in as it is", async () => {
    const root = await estate();
    let t = NOW.getTime();
    const tick = () => new Date((t += 5000));
    const r = await featureStage(root, CHANGE, {
      runtime: new HandoffRuntime({ root, validate: async () => [], now: tick }),
      now: NOW,
      context: { engine: false },
    });
    const run = r.waiting!.runId;
    const file = join(root, ".runs", CHANGE, run, "feature-answer.yaml");
    await writeFile(file, BAD);
    const first = io();
    expect(await handoffDone(root, run, first.io)).toBe(1);
    expect(first.err.join("\n")).toContain("The stage's checks found 1 problem in your draft:");
    expect(first.err.join("\n")).toContain("forge-orders.no-such-flow");
    expect(first.err.join("\n")).toContain(`run atticus handoff done ${run} again`);
    // Fixed: handed in.
    await writeFile(file, PLACED);
    const fixed = io();
    expect(await handoffDone(root, run, fixed.io)).toBe(0);
    const read = await featureStage(root, CHANGE, {
      runtime: new HandoffRuntime({ root, validate: async () => [], now: tick }),
      now: NOW,
      context: { engine: false },
      resume: run,
    });
    expect(read.state).toBe("done");

    // Another draft that never gets clean is handed in as it is after the limit (3 checks).
    const again = await featureStage(root, CHANGE, {
      runtime: new HandoffRuntime({ root, validate: async () => [], now: tick }),
      now: NOW,
      context: { engine: false },
      force: true,
    });
    const run2 = again.waiting!.runId;
    const file2 = join(root, ".runs", CHANGE, run2, "feature-answer.yaml");
    await writeFile(file2, BAD);
    const codes: number[] = [];
    const last = io();
    for (let i = 0; i < 3; i++)
      codes.push(await handoffDone(root, run2, i < 2 ? io().io : last.io));
    expect(codes).toEqual([1, 1, 0]);
    expect(last.out.join("\n")).toContain(
      "handed in as it is after 3 checks: the stage hands its problems back with the next draft",
    );
  });

  it("atticus stage check runs the same checks on a file, for headless Claude Code", async () => {
    const root = await estate();
    const f = join(root, "draft.yaml");
    await writeFile(f, BAD);
    const o = io();
    expect(await stageCheck(root, CHANGE, "feature", f, o.io)).toBe(1);
    expect(o.out.join("\n")).toContain("The stage's checks found 1 problem in your draft:");
    await writeFile(f, PLACED);
    const ok = io();
    expect(await stageCheck(root, CHANGE, "feature", f, ok.io)).toBe(0);
    expect(ok.out).toEqual(["The stage's checks find nothing to fix: hand the draft in."]);
  });
});

describe("the critic never reviews a draft its stage refused (W4)", () => {
  it("atticus critic refuses while the phase's stage stopped on its own draft, and says to run the stage", async () => {
    const root = await estate();
    await mkdir(join(root, "openspec/changes", CHANGE, "stage"), { recursive: true });
    await writeFile(
      join(root, "openspec/changes", CHANGE, "stage/feature.yaml"),
      `schemaVersion: 1\nchange: ${CHANGE}\nstage: feature\niteration: 3\nstate: stopped\nupdatedAt: 2026-10-24T09:00:00Z\n`,
    );
    const o = io();
    expect(await critic(root, CHANGE, {}, o.io, { now: "2026-10-24T09:00:00Z" })).toBe(1);
    expect(o.err.join("\n")).toContain(
      `The feature stage stopped on its own draft, which doesn't pass the stage's checks, so the critic doesn't review it: fix it and run atticus change feature ${CHANGE}; the stage runs the gate's critic round once its draft passes.`,
    );
    expect(existsSync(join(root, "openspec/changes", CHANGE, "review"))).toBe(false);
  });
});

describe("the context line leaves out the change's own new names (ADR 0087 addendum, V)", () => {
  const report = (unknown: string[], known: string[]) => ({
    engine: true,
    budget: 1000,
    tokens: 100,
    picked: [],
    leftOut: [],
    unknown,
    known: known.map((name) => ({
      name,
      at: "openspec/changes/pin-order-note/target-flows/forge-orders.pin-note.yaml:6",
      how: "target-flow" as const,
    })),
  });

  it("lists only the names nothing knows; an endpoint the target flows declare new isn't one", () => {
    const lines = contextLines(
      report(["PUT /orders/{orderId}/pin", "Quillfeather Risk"], ["PUT /orders/{orderId}/pin"]),
    );
    expect(lines).toContain(
      "Names the change uses that nothing in the index has: Quillfeather Risk.",
    );
    expect(lines.join("\n")).not.toContain("nothing in the index has: PUT");
  });

  it("prints no such line when every unknown name is known", () => {
    const lines = contextLines(
      report(["PUT /orders/{orderId}/pin"], ["PUT /orders/{orderId}/pin"]),
    );
    expect(lines.some((l) => l.startsWith("Names the change uses"))).toBe(false);
  });
});
