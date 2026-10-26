import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { act, gateStatus } from "@maycombhq/naysayer";
import { featureStage, PlannerError } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-critic-rounds-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\nretrieval: { expansion: false }\n",
  );
  const rows = [
    ...(parse(readFileSync(join(FIX, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const [under, list] of [
    ["catalog/generated", rows],
    ["knowledge/items", parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]],
  ] as const)
    for (const r of list) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
      const f = join(root, under, recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIX, "lenses/checklists"), join(root, "org-pack/checklists"), { recursive: true });
  return root;
}

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved; a rejected order is refused.
features:
  - id: cap-ordering
    why: Placing an order is the feature that gains the screen.
flows:
  - id: forge-orders.place-order
    how: changed
    why: The screen runs between receiving the order and reserving stock.
  - id: forge-stock.reserve-stock
    how: read
    why: Reserving stock happens only after the screen passes.
gaps:
  - what: No call to Northwind Pay exists yet.
    why: The estate never talks to the fraud screen today.
`;

const FINDING = `findings:
  - rule: flow-use-matches-estate
    artifact: feature.md
    summary: Reserving stock now waits for the screen's verdict, so its steps change.
    why: A flow marked read gets no target flow.
    fix: Mark forge-stock.reserve-stock as changed.
    evidence:
      - { path: feature.md, quote: "Flow forge-stock.reserve-stock (read)" }
`;

async function bytesUnder(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? await bytesUnder(p) : (await stat(p)).size;
  }
  return n;
}

const roundMeta = async (root: string, round: number) =>
  parse(
    await readFile(
      join(root, "openspec/changes", CHANGE, "review/define", String(round), "meta/round.yaml"),
      "utf8",
    ),
  ) as {
    lenses: {
      lens: string;
      state: string;
      held?: boolean;
      reason?: string;
      context?: { tokens: number; since?: number; unchanged?: string[] };
    }[];
  };

/** A lens finds the flow marked read while a line of what it was given still says so. */
const truthLens = (prompt: string) =>
  /\n\d+: .*Flow forge-stock\.reserve-stock \(read\)/.test(prompt) ? FINDING : "findings: []";

/**
 * ADR 0115 addendum (2026-10-25, critic cost and integrity). A live run spent 14 critic rounds of
 * four lenses on one change, about 67.5k tokens a lens call, and the drafting assistant dismissed
 * a finding itself. A stage with three drafts, on the recorded Forge stage fixture: the first fails
 * the code checks and costs no lens call; the second is reviewed whole; the third's lenses see
 * only what changed and the findings still open. The numbers before this addendum, on the same
 * scenario: four lens calls of 1,973, 1,962, 1,974 and 1,963 tokens (7,872), every round's records
 * in review/ (8,034 bytes). The budget below was re-pinned when this landed beside the OpenSpec
 * and task-knowledge addenda, whose own sources (openspec instructions, a task's knowledge) make
 * every lens prompt longer: what this test holds is the saving, that a redraft's round costs less
 * than the whole review before it, with the full-review budget measured again on that prompt.
 */
describe("the critic's rounds over a stage with three drafts", () => {
  it("spends no lens call on a draft the code checks fail, and re-reviews only the diff", async () => {
    const root = await estateRoot();
    let draft = 0;
    const calls: { lens: string; draft: number; tokens: number; prompt: string }[] = [];
    const rt = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) {
          calls.push({
            lens: req.agent.id,
            draft,
            tokens: req.pack.manifest.totalTokens,
            prompt: req.pack.prompt,
          });
          return req.agent.id === "true-critic" ? truthLens(req.pack.prompt) : "findings: []";
        }
        draft++;
        if (draft === 1) return PLACED.replace("cap-ordering", "cap-checkout");
        if (draft === 2) return PLACED;
        return PLACED.replace("how: read", "how: changed");
      },
      { now: () => NOW },
    );
    const r = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r).toMatchObject({ state: "done", drafts: 3 });
    // Draft 1 failed the code checks: no lens saw it.
    expect(calls.map((c) => [c.draft, c.lens])).toEqual([
      [2, "true-critic"],
      [2, "complete-critic"],
      [3, "true-critic"],
      [3, "complete-critic"],
    ]);
    // Draft 3's lenses saw what changed since round 1 and the finding still open, not the stage.
    const second = calls.filter((c) => c.draft === 3);
    for (const c of second) {
      expect(c.prompt).toContain("This review is of what changed since round 1");
      expect(c.prompt).toContain("-: - Flow forge-stock.reserve-stock (read)");
      expect(c.prompt).not.toContain("Other changes in flight");
    }
    const truth = second.find((c) => c.lens === "true-critic")!.prompt;
    expect(truth).toContain('<atticus-data id="open-findings"');
    expect(truth).toContain("Reserving stock now waits for the screen's verdict");
    const meta = await roundMeta(root, 2);
    for (const l of meta.lenses) expect(l.context).toMatchObject({ since: 1 });
    // Tokens per stage, before and after (see the comment above the describe).
    const first = calls.filter((c) => c.draft === 2).reduce((n, c) => n + c.tokens, 0);
    const again = second.reduce((n, c) => n + c.tokens, 0);
    expect(again).toBeLessThan(first);
    const total = first + again;
    expect(total).toBeLessThan(9_000);
    // Only the newest round keeps the lenses' prompts and answers in review/.
    const dir = join(root, "openspec/changes", CHANGE, "review/define");
    await expect(stat(join(dir, "1/meta/lenses"))).rejects.toThrow();
    expect((await readdir(join(dir, "2/meta/lenses"))).sort()).toEqual([
      "complete.answer.yaml",
      "complete.prompt.md",
      "true.answer.yaml",
      "true.prompt.md",
    ]);
    const review = await bytesUnder(join(root, "openspec/changes", CHANGE, "review"));
    console.log(JSON.stringify({ lensTokens: calls.map((c) => c.tokens), total, review }));
  });
});

describe("a finding the drafting assistant calls not relevant", () => {
  /** The feature stage in hand-off mode, with its own moving clock. */
  function handoff(root: string) {
    let t = NOW.getTime();
    const tick = () => new Date((t += 5000));
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: tick });
    const step = (resume?: string) =>
      featureStage(root, CHANGE, { runtime: rt(), now: tick(), ...(resume ? { resume } : {}) });
    const answer = async (run: string, file: string, text: string) => {
      await writeFile(join(root, ".runs", CHANGE, run, file), text);
      return rt().done(run);
    };
    return { step, answer };
  }

  it("stays open, waiting on a person, until a person's resolution closes it", async () => {
    const root = await estateRoot();
    const h = handoff(root);
    // Draft 1 fails the code checks and goes straight back for draft 2: no lens is handed off.
    const d1 = await h.step();
    await h.answer(
      d1.waiting!.runId,
      "feature-answer.yaml",
      PLACED.replace("cap-ordering", "cap-checkout"),
    );
    const d2 = await h.step(d1.waiting!.runId);
    expect(d2.waiting?.lens).toBeUndefined();
    await h.answer(d2.waiting!.runId, "feature-answer.yaml", PLACED);
    const truth = await h.step(d2.waiting!.runId);
    expect(truth.waiting?.lens).toBe("true");
    const prompt = await readFile(
      join(root, ".runs", CHANGE, truth.waiting!.runId, "prompt.md"),
      "utf8",
    );
    await h.answer(truth.waiting!.runId, "findings-true.yaml", truthLens(prompt));
    const complete = await h.step(truth.waiting!.runId);
    await h.answer(complete.waiting!.runId, "findings-complete.yaml", "findings: []\n");
    // The true lens's blocking finding sends the draft back: draft 3 is with the assistant.
    const d3 = await h.step(complete.waiting!.runId);
    expect(d3.waiting?.lens).toBeUndefined();
    const found = (await gateStatus(root, CHANGE, "define")).findings.find(
      (f) => f.finding.rule === "flow-use-matches-estate",
    )!.finding;

    // The drafter dismisses the finding itself, as a live run's did, and answers the same draft.
    const said = await act(root, CHANGE, found.id, "not-relevant", {
      by: "claude",
      reason: "Reserving stock only reads the verdict.",
    });
    expect(said.finding.state).toBe("open");
    await h.answer(d3.waiting!.runId, "feature-answer.yaml", PLACED);
    const stop = await h.step(d3.waiting!.runId).then(
      () => undefined,
      (e: unknown) => e as PlannerError,
    );
    expect(stop).toBeInstanceOf(PlannerError);
    expect(stop!.message).toContain("only a person's decision closes it");
    expect(stop!.message).toContain("Proposed by the assistant (claude), waiting on a person");
    // Nothing changed since round 1, so round 2 called no lens and doesn't count; the finding is
    // carried, still open, with the proposal.
    const r2 = await roundMeta(root, 2);
    expect(r2.lenses.map((l) => [l.state, l.held])).toEqual([
      ["skipped", true],
      ["skipped", true],
    ]);
    const s = await gateStatus(root, CHANGE, "define");
    expect(s.round).toBe(2);
    expect(s.mayProceed).toBe(false);
    const open = s.findings.find((f) => f.finding.rule === "flow-use-matches-estate")!;
    expect(open.finding.state).toBe("open");
    expect(open.proposal).toMatchObject({ by: "claude", claim: "not-relevant" });
    // Running the stage again doesn't draft over the decision a person owes.
    await expect(h.step()).rejects.toThrow(/waiting on a person/);

    // A person decides: the stage finishes, and the record says whose reason it was.
    const decided = await act(root, CHANGE, open.finding.id, "not-relevant", { by: "pat" });
    expect(decided.finding.resolution).toMatchObject({
      by: "pat",
      reason: "Reserving stock only reads the verdict. (proposed by claude; accepted by pat)",
    });
    const done = await h.step();
    expect(done.state).toBe("done");
    const after = await gateStatus(root, CHANGE, "define");
    expect(
      after.findings.find((f) => f.finding.rule === "flow-use-matches-estate")!.finding.state,
    ).toBe("dismissed");
    const sizes = {
      review: await bytesUnder(join(root, "openspec/changes", CHANGE, "review")),
      runs: await bytesUnder(join(root, ".runs")),
    };
    console.log(JSON.stringify(sizes));
  });
});
