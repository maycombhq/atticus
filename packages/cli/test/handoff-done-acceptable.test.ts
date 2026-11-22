import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { featureStage, PlannerError } from "@maycombhq/planner";
import { findingAction } from "../src/critic-commands.js";
import { handoffDone } from "../src/workspace-commands.js";

/**
 * ADR 0203 A, the hand-off's half (addendum 2026-11-22): a draft whose every blocking finding is
 * one a person may accept is not refused by `atticus handoff done` until its three checks are
 * spent. It is handed in on its first check, its findings are written on the stage's own gate at
 * once, and the stage stops for a person, so a person can accept straight away; the assistant can
 * still hand in a fixed draft instead. A draft with any other blocking finding is refused as
 * before. On the invented stage fixtures (CLAUDE.md rule 3).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-11-22T09:00:00Z");
const CHANGE = "add-fraud-check";
const GATE = "stage-feature";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-handoff-accept-"));
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
/** The same placement and a new flow in a repo the estate doesn't have yet: a person may accept it. */
const NEW_REPO = `${PLACED}newFlows:
  - name: Screen an order
    repo: forge-screening
    why: A screening service asks Northwind Pay about each order.
`;
/** And a flow nobody knows, which no one may accept. */
const MIXED = NEW_REPO.replace("forge-orders.place-order", "forge-orders.no-such-flow");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

let t = NOW.getTime();
const tick = () => new Date((t += 5000));
const stage = (root: string, o: { resume?: string } = {}) =>
  featureStage(root, CHANGE, {
    runtime: new HandoffRuntime({ root, validate: async () => [], now: tick }),
    now: NOW,
    context: { engine: false },
    ...o,
  });

/** The newest round of the stage's own gate: each finding's id, rule and state. */
async function gate(root: string): Promise<{ id: string; rule: string; state: string }[]> {
  const dir = join(root, "openspec/changes", CHANGE, "review", GATE);
  const rounds = (await readdir(dir).catch(() => [] as string[]))
    .filter((r) => /^\d+$/.test(r))
    .sort((a, b) => +a - +b);
  const last = rounds.at(-1);
  if (!last) return [];
  const files = (await readdir(join(dir, last))).filter((f) => f.endsWith(".yaml"));
  return Promise.all(
    files.map(async (f) => {
      const y = parse(await readFile(join(dir, last, f), "utf8")) as Record<string, string>;
      return { id: y.id!, rule: y.rule!, state: y.state! };
    }),
  );
}
const loopState = async (root: string) =>
  /^state: (\S+)$/m.exec(
    await readFile(join(root, "openspec/changes", CHANGE, "stage/feature.yaml"), "utf8"),
  )?.[1];

/** The stage handed off, with the assistant's answer written. */
async function handedOff(root: string, answer: string): Promise<string> {
  const r = await stage(root);
  const run = r.waiting!.runId;
  await writeFile(join(root, ".runs", CHANGE, run, "feature-answer.yaml"), answer);
  return run;
}

const accept = async (root: string, id: string) => {
  const o = io();
  const code = await findingAction(
    root,
    CHANGE,
    id,
    "waive",
    { by: "priya", reason: "forge-screening is created in this release", gate: GATE },
    o.io,
    { now: "2026-11-22T09:30:00Z" },
  );
  expect(code, o.err.join("\n")).toBe(0);
};

describe("handoff done and a draft whose every blocking finding a person may accept", () => {
  it("hands it in on its first check and writes its findings on the stage's gate at once", async () => {
    const root = await estate();
    const run = await handedOff(root, NEW_REPO);
    const done = io();
    expect(await handoffDone(root, run, done.io)).toBe(0);
    const said = done.out.join("\n");
    expect(said).toContain(
      "feature-answer.yaml is handed in for a person: the stage's checks found 1 finding a person may accept (feature.unknown-repo), so it is on the stage's gate now.",
    );
    expect(said).toContain(`atticus finding ${CHANGE} stage-`);
    expect(said).toContain(`atticus change feature ${CHANGE} --resume ${run}`);
    // On the gate before the stage read the answer in: a person can accept it straight away.
    const g = await gate(root);
    expect(g.map((f) => [f.rule, f.state])).toEqual([["feature.unknown-repo", "open"]]);
    // Addressed to a person, not to the assistant that handed it in.
    expect(said).toContain(
      `A person accepts it in the app, or with: atticus finding ${CHANGE} ${g[0]!.id} waive --reason "<why>"`,
    );
    expect(said).toContain(
      "Or the person tells the assistant how to fix the draft, and the stage drafts again.",
    );
    expect(said).toContain(
      `Once it is accepted, the stage goes on from this draft: in the app by itself, in a terminal with: atticus change feature ${CHANGE} --resume ${run}`,
    );
  });

  it("accepted before the stage reads it in: the stage is done on that one draft", async () => {
    const root = await estate();
    const run = await handedOff(root, NEW_REPO);
    expect(await handoffDone(root, run, io().io)).toBe(0);
    await accept(root, (await gate(root))[0]!.id);
    const r = await stage(root, { resume: run });
    expect(r.state).toBe("done");
    expect(r.iteration).toBe(1);
    expect((await gate(root)).map((f) => [f.rule, f.state])).toEqual([
      ["feature.unknown-repo", "waived"],
    ]);
  });

  it("not yet accepted: the stage stops for a person on its first draft, and is done once it is accepted, with no new draft", async () => {
    const root = await estate();
    const run = await handedOff(root, NEW_REPO);
    expect(await handoffDone(root, run, io().io)).toBe(0);
    const stopped = await stage(root, { resume: run }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(PlannerError);
    const msg = (stopped as PlannerError).message;
    expect(msg).toContain(
      "The feature stage stopped after 1 draft for a person: its draft has 1 finding a person may accept.",
    );
    expect(msg).toContain(
      `a person accepts it in the app, or with: atticus finding ${CHANGE} stage-`,
    );
    expect(await loopState(root)).toBe("stopped");
    // No second prompt went to the assistant.
    expect(await readdir(join(root, ".runs", CHANGE))).toEqual([run]);
    const g = await gate(root);
    expect(g.map((f) => [f.rule, f.state])).toEqual([["feature.unknown-repo", "open"]]);
    await accept(root, g[0]!.id);
    const again = await stage(root);
    expect(again.state).toBe("done");
    expect(again.drafts).toBe(0);
    expect(await readdir(join(root, ".runs", CHANGE))).toEqual([run]);
  });

  it("the assistant may hand in a fixed draft instead: the stage drafts again, and the fix passes", async () => {
    const root = await estate();
    const run = await handedOff(root, NEW_REPO);
    expect(await handoffDone(root, run, io().io)).toBe(0);
    await stage(root, { resume: run }).catch(() => undefined);
    const next = await stage(root);
    expect(next.state).toBe("waiting");
    const run2 = next.waiting!.runId;
    expect(run2).not.toBe(run);
    await writeFile(join(root, ".runs", CHANGE, run2, "feature-answer.yaml"), PLACED);
    expect(await handoffDone(root, run2, io().io)).toBe(0);
    expect((await stage(root, { resume: run2 })).state).toBe("done");
    expect((await gate(root)).filter((f) => f.state === "open")).toEqual([]);
  });

  it("a draft with a finding no one may accept beside it is refused as before, and nothing is written on the gate", async () => {
    const root = await estate();
    const run = await handedOff(root, MIXED);
    const first = io();
    expect(await handoffDone(root, run, first.io)).toBe(1);
    expect(first.err.join("\n")).toContain("The stage's checks found 2 problems in your draft:");
    expect(await gate(root)).toEqual([]);
  });
});
