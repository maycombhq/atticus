import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import type { GateStatus } from "@maycombhq/naysayer";
import { EXPAND_AGENT } from "@maycombhq/planner";
import { stageCli, wroteLines } from "../src/stage-commands.js";
import { statusLine } from "../src/critic-commands.js";

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
