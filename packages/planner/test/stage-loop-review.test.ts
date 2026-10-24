import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { answerQuestion, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { act, gateStatus, runCritic } from "@maycombhq/naysayer";
import {
  architectureStage,
  checkDeltas,
  featureStage,
  storiesStage,
  FlowDelta,
  loadEstate,
  PlannerError,
} from "../src/index.js";

/**
 * What an adversarial review of the stage loop found (ADR 0115 addendum), each as the scenario
 * that showed it: a lens run lost or failed, a newer critic round at the gate, the gate's round
 * limit, a done stage once its own code is in the catalog, a question a person answered, a run
 * of another change, and the hand-backs and citations the drafter gets.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function estateRoot(o: { lenses?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-review-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  await writeRecords(root, "catalog/generated", rows);
  await writeRecords(
    root,
    "knowledge/items",
    parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[],
  );
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  if (o.lenses)
    await cp(join(FIX, "lenses/checklists"), join(root, "org-pack/checklists"), {
      recursive: true,
    });
  return root;
}

async function writeRecords(root: string, under: string, rows: unknown[]): Promise<void> {
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, under, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
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

const DELTAS = `flows:
  - flow: forge-orders.place-order
    repo: forge-orders
    change: modify
    why: The order is screened before stock is reserved.
    steps:
      - op: add
        after: 1
        kind: call-out
        what: Northwind Pay screens the order for fraud
        to: { component: northwind-pay, entry: "POST /v1/screenings", new: true }
        fields: { sends: [sku, quantity, cardToken], returns: [verdict] }
      - op: add
        after: 1
        kind: branch
        what: A rejected order is refused with 422 and nothing is reserved
        fields: { reads: [verdict] }
      - op: add
        after: 1
        kind: write
        what: The screen's verdict is kept
        store: { table: forge-orders-db.screenings, new: true, columns: [verdict], types: { verdict: varchar(20) }, classification: { verdict: internal }, migration: V4__add_fraud_verdict.sql, retention: kept for a year }
      - op: change
        step: 4
        kind: write
        what: The order is inserted with the screen's verdict
        store: { table: forge-orders-db.orders, columns: [sku, quantity, fraud_verdict], types: { fraud_verdict: varchar(20) }, classification: { fraud_verdict: internal }, migration: V4__add_fraud_verdict.sql }
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

/** A clock that moves on 5 s at each call, so each hand-off run gets its own id. */
function clock() {
  let t = NOW.getTime();
  return () => new Date((t += 5000));
}

/** The feature stage in hand-off mode, with its own moving clock. */
function handoff(root: string) {
  const tick = clock();
  const rt = () => new HandoffRuntime({ root, validate: async () => [], now: tick });
  const out = (run: string, file: string) => join(root, ".runs", CHANGE, run, file);
  const step = (resume?: string) =>
    featureStage(root, CHANGE, { runtime: rt(), now: tick(), ...(resume ? { resume } : {}) });
  const answer = async (run: string, file: string, text: string) => {
    await writeFile(out(run, file), text);
    return rt().done(run);
  };
  return { rt, out, step, answer };
}

const loopOf = async (root: string, stage = "feature") =>
  parse(await readFile(join(root, "openspec/changes", CHANGE, `stage/${stage}.yaml`), "utf8")) as {
    state: string;
    review?: unknown;
    findings: { rule: string; question?: string }[];
  };
const roundMeta = async (root: string, round: number) =>
  parse(
    await readFile(
      join(root, "openspec/changes", CHANGE, "review/define", String(round), "meta/round.yaml"),
      "utf8",
    ),
  ) as { lenses: { lens: string; state: string; runId?: string; reason?: string }[] };

const stopped = async (p: Promise<unknown>): Promise<PlannerError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PlannerError);
  expect((e as PlannerError).code).toBe("stopped");
  return e as PlannerError;
};

describe("a lens run that is lost, or whose answer failed its check (B1, M6)", () => {
  it("records the lost lens as not reviewed, offers the next one, then stops; a rerun reviews the same draft again", async () => {
    const root = await estateRoot({ lenses: true });
    const h = handoff(root);
    const first = await h.step();
    await h.answer(first.waiting!.runId, "feature-answer.yaml", PLACED);
    const second = await h.step(first.waiting!.runId);
    expect(second.waiting).toMatchObject({ lens: "business" });
    // The business lens's run folder goes (a cleaned .runs/, another machine).
    await rm(join(root, ".runs", CHANGE, second.waiting!.runId), { recursive: true, force: true });
    const third = await h.step();
    // The draft isn't thrown away: the other lens is offered.
    expect(third.drafts).toBe(0);
    expect(third.waiting).toMatchObject({ lens: "architecture" });
    expect(third.notes.join("\n")).toContain(`Run ${second.waiting!.runId} is no longer there`);
    expect((await roundMeta(root, 1)).lenses.map((l) => [l.lens, l.state])).toEqual([
      ["business", "failed"],
      ["architecture", "waiting"],
    ]);
    await h.answer(third.waiting!.runId, "findings-architecture.yaml", "findings: []\n");
    // Every lens is in, but one never reviewed: the stage stops rather than say it is done.
    const e = await stopped(h.step(third.waiting!.runId));
    expect(e.message).toContain("The critic's business lens didn't review draft 1");
    expect((await loopOf(root)).review).toBeUndefined();
    // Run again: the same draft goes to a new critic round's lenses; nothing is drafted.
    const again = await h.step();
    expect(again.drafts).toBe(0);
    expect(again.waiting).toMatchObject({ lens: "business" });
    expect((await roundMeta(root, 2)).lenses.map((l) => l.state)).toEqual(["waiting", "waiting"]);
  });

  it("offers a lens whose answer failed its check again, rather than drafting again", async () => {
    const root = await estateRoot({ lenses: true });
    const tick = clock();
    // As the CLI checks a lens answer: it must be a findings list.
    const rt = () =>
      new HandoffRuntime({
        root,
        validate: async (f, req) =>
          !req.outputPath.startsWith("findings-") || /findings:/.test(await readFile(f, "utf8"))
            ? []
            : ["no findings list"],
        now: tick,
      });
    const step = (resume?: string) =>
      featureStage(root, CHANGE, { runtime: rt(), now: tick(), ...(resume ? { resume } : {}) });
    const first = await step();
    await writeFile(
      join(root, ".runs", CHANGE, first.waiting!.runId, "feature-answer.yaml"),
      PLACED,
    );
    await rt().done(first.waiting!.runId);
    const lens = (await step(first.waiting!.runId)).waiting!;
    await writeFile(join(root, ".runs", CHANGE, lens.runId, "findings-business.yaml"), "");
    expect((await rt().done(lens.runId)).state).toBe("failed");
    // Resumed, or run again: the same lens, to be fixed and sent again.
    const resumed = await step(lens.runId);
    expect(resumed).toMatchObject({ state: "waiting", drafts: 0, waiting: lens });
    const plain = await step();
    expect(plain).toMatchObject({ state: "waiting", drafts: 0, waiting: lens });
  });

  it("reads a lens answer that isn't a review (empty) as a lens that didn't review, and stops", async () => {
    const root = await estateRoot({ lenses: true });
    const h = handoff(root);
    const first = await h.step();
    await h.answer(first.waiting!.runId, "feature-answer.yaml", PLACED);
    const business = (await h.step(first.waiting!.runId)).waiting!;
    await h.answer(business.runId, "findings-business.yaml", "");
    const architecture = (await h.step(business.runId)).waiting!;
    expect(architecture.lens).toBe("architecture");
    await h.answer(architecture.runId, "findings-architecture.yaml", "findings: []\n");
    const e = await stopped(h.step(architecture.runId));
    expect(e.message).toContain("business lens didn't review");
    expect((await roundMeta(root, 1)).lenses.map((l) => l.state)).toEqual(["failed", "ran"]);
  });
});

describe("a newer critic round at the gate while the stage waits on its lenses (H2)", () => {
  it("still waits on its own round's lenses", async () => {
    const root = await estateRoot({ lenses: true });
    const h = handoff(root);
    const first = await h.step();
    await h.answer(first.waiting!.runId, "feature-answer.yaml", PLACED);
    const business = (await h.step(first.waiting!.runId)).waiting!;
    // A person runs the critic by hand at the same gate (rules only): round 2.
    expect((await runCritic(root, CHANGE, { gate: "define" })).round).toBe(2);
    const r = await h.step(business.runId);
    expect(r).toMatchObject({ state: "waiting", waiting: business });
    await h.answer(business.runId, "findings-business.yaml", "findings: []\n");
    const next = await h.step(business.runId);
    expect(next.waiting).toMatchObject({ lens: "architecture" });
  });
});

describe("the gate's round limit (H3)", () => {
  async function limited(root: string, max = 1): Promise<void> {
    await writeFile(
      join(root, "org-pack/gates.yaml"),
      `schemaVersion: 2
gates:
  - { id: define, phase: define, approvers: [product-owner], maxAuthorRounds: ${max}, checks: [{ check: openspec-validate }] }
  - { id: design, phase: design, approvers: [architect], checks: [{ check: openspec-validate }] }
  - { id: plan, phase: plan, approvers: [team-lead], checks: [{ check: openspec-validate }] }
  - { id: build, phase: build, approvers: [developer], checks: [{ check: tests-pass }] }
  - { id: qa, phase: qa, approvers: [qa], checks: [{ check: tests-pass }] }
  - { id: release, phase: release, approvers: [delivery-lead], checks: [{ check: snow-requests-closed }] }
`,
    );
  }

  it("stops for a person when the gate has no critic round left, rather than say nothing blocks", async () => {
    const root = await estateRoot({ lenses: true });
    await limited(root);
    const rt = new MockRuntime(
      (req: AiRequest) =>
        req.agent.id === "architecture-critic"
          ? FINDING
          : req.agent.id.endsWith("-critic")
            ? "findings: []"
            : PLACED,
      { now: () => NOW },
    );
    const e = await stopped(featureStage(root, CHANGE, { runtime: rt, now: NOW }));
    expect(e.message).toContain("the most it allows");
    expect((await loopOf(root)).state).toBe("stopped");
  });

  it("doesn't count a round in which no lens reviewed (Claude Code missing, a timeout) toward the limit", async () => {
    const root = await estateRoot({ lenses: true });
    await limited(root);
    let up = false;
    const rt = new MockRuntime(
      (req: AiRequest) => {
        if (!req.agent.id.endsWith("-critic")) return PLACED;
        if (!up) throw new Error("Claude Code (claude) is not on PATH");
        return "findings: []";
      },
      { now: () => NOW },
    );
    // Twice the lenses can't start: each round has every lens failed (layer 1 still ran).
    for (const _ of [1, 2]) {
      const e = await stopped(featureStage(root, CHANGE, { runtime: rt, now: NOW }));
      expect(e.message).toContain("didn't review");
      expect(e.message).not.toContain("the most it allows");
    }
    up = true;
    const r = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r.state).toBe("done");
    expect((await roundMeta(root, 3)).lenses.map((l) => l.state)).toEqual(["ran", "ran"]);
  });

  // Found on a real metarepo: round 2 of 2 had one real blocking finding; a person fixed the
  // draft by hand and applied the finding, and the stage still said "a person decides now".
  describe("a fix a person applied when no critic round is left", () => {
    // The architecture lens finds the flow marked read until the placement marks it changed.
    const lens = () =>
      new MockRuntime(
        (req: AiRequest) =>
          req.agent.id === "architecture-critic"
            ? req.pack.prompt.includes("Flow forge-stock.reserve-stock (read)")
              ? FINDING
              : "findings: []"
            : req.agent.id.endsWith("-critic")
              ? "findings: []"
              : PLACED,
        { now: () => NOW },
      );
    const stuck = async (root: string) => {
      await limited(root, 2);
      const e = await stopped(featureStage(root, CHANGE, { runtime: lens(), now: NOW }));
      expect(e.message).toContain("the most it allows");
      const s = await gateStatus(root, CHANGE, "define");
      expect(s.round).toBe(2);
      expect(s.humanDecides).toBe(true);
      return s.findings.find((f) => f.finding.rule === "flow-use-matches-estate")!.finding.id;
    };
    const placement = (root: string) => join(root, "openspec/changes", CHANGE, "feature.yaml");

    it("gets one checking round past the limit, which reviews the fix and finishes the stage", async () => {
      const root = await estateRoot({ lenses: true });
      const id = await stuck(root);
      // The person fixes the placement by hand (feature.yaml), then applies the finding.
      const placed = parse(await readFile(placement(root), "utf8")) as {
        flows: { id: string; how: string }[];
      };
      placed.flows.find((f) => f.id === "forge-stock.reserve-stock")!.how = "changed";
      await writeFile(placement(root), stringify(placed));
      const applied = await act(root, CHANGE, id, "apply", { by: "pat" });
      expect(applied.message).toContain("one checking round past the limit");
      expect(applied.message).not.toContain("The next critic round checks the fix");
      expect((await gateStatus(root, CHANGE, "define")).checkRound).toBe(true);
      // The stage runs the checking round on the draft on file, drafts nothing, and is done.
      const r = await featureStage(root, CHANGE, { runtime: lens(), now: NOW });
      expect(r.state).toBe("done");
      expect(r.drafts).toBe(0);
      expect((await roundMeta(root, 3)) as unknown).toMatchObject({
        checkRound: { after: 2, actedOn: [id] },
      });
      // Nothing blocking is open; the fixture's own knowledge gap waits for its owner as before.
      expect((await gateStatus(root, CHANGE, "define")).open.blocking).toBe(0);
    });

    it("goes to a person again when the checking round still finds it, without drafting over the fix", async () => {
      const root = await estateRoot({ lenses: true });
      const id = await stuck(root);
      // Marked applied, but the placement on file wasn't fixed.
      await act(root, CHANGE, id, "apply", { by: "pat" });
      const e = await stopped(featureStage(root, CHANGE, { runtime: lens(), now: NOW }));
      expect(e.message).toContain("the checking round past its limit, found a blocking finding");
      expect((await loopOf(root)).state).toBe("stopped");
      const s = await gateStatus(root, CHANGE, "define");
      expect(s.round).toBe(3);
      expect(s.humanDecides).toBe(true);
      expect(s.checkRound).toBe(false);
      // Bounded: a further run is refused until a person acts on round 3's finding.
      const again = await stopped(featureStage(root, CHANGE, { runtime: lens(), now: NOW }));
      expect(again.message).toContain("the most it allows, and a checking round past it");
      // A waiver is a person's decision too, recorded with a reason, never silent.
      const id3 = s.findings.find((f) => f.finding.rule === "flow-use-matches-estate")!.finding.id;
      await act(root, CHANGE, id3, "waive", { by: "pat", reason: "Reserving stock is read only." });
      const r = await featureStage(root, CHANGE, { runtime: lens(), now: NOW });
      expect(r.state).toBe("done");
      const waived = (await gateStatus(root, CHANGE, "define")).findings.find(
        (f) => f.finding.rule === "flow-use-matches-estate",
      )!.finding;
      expect(waived).toMatchObject({ round: 4, state: "waived" });
    });
  });

  it("opens no critic round for a draft that fails the stage's own checks", async () => {
    const root = await estateRoot({ lenses: true });
    await limited(root);
    let n = 0;
    const rt = new MockRuntime(
      (req: AiRequest) =>
        req.agent.id.endsWith("-critic")
          ? "findings: []"
          : n++ === 0
            ? PLACED.replace("cap-ordering", "cap-checkout")
            : PLACED,
      { now: () => NOW },
    );
    const r = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(2);
    expect((await roundMeta(root, 1)).lenses.map((l) => l.state)).toEqual(["ran", "ran"]);
  });
});

describe("a done architecture stage once the change's own code is in the catalog (H4)", () => {
  it("stays done: its migration, table and column are its own, merged", async () => {
    const root = await estateRoot();
    const placed = await featureStage(root, CHANGE, {
      runtime: new MockRuntime(
        (req) => (req.agent.id.endsWith("-critic") ? "findings: []" : PLACED),
        {
          now: () => NOW,
        },
      ),
      now: NOW,
    });
    expect(placed.state).toBe("done");
    let calls = 0;
    const rt = () =>
      new MockRuntime(
        (req: AiRequest) => {
          if (req.agent.id.endsWith("-critic")) return "findings: []";
          calls++;
          return DELTAS;
        },
        { now: () => NOW },
      );
    const first = await architectureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(first.state).toBe("done");
    const before = calls;
    // The change's code merged and the repo was rescanned: V3 and V4, the column and the table.
    await writeRecords(
      root,
      "catalog/generated",
      parse(readFileSync(join(FIX, "merged/catalog.yaml"), "utf8")) as unknown[],
    );
    const again = await architectureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(again.state).toBe("done");
    expect(again.drafts).toBe(0);
    expect(calls).toBe(before);
  });
});

describe("a done architecture stage once today's flow changed", () => {
  const deltaRuntime = (count: () => void) =>
    new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        count();
        return DELTAS;
      },
      { now: () => NOW },
    );
  async function doneThenRescanned(state: "build" | "design") {
    const root = await estateRoot();
    await featureStage(root, CHANGE, {
      runtime: new MockRuntime(
        (req) => (req.agent.id.endsWith("-critic") ? "findings: []" : PLACED),
        {
          now: () => NOW,
        },
      ),
      now: NOW,
    });
    let calls = 0;
    const first = await architectureStage(root, CHANGE, {
      runtime: deltaRuntime(() => calls++),
      now: NOW,
    });
    expect(first.state).toBe("done");
    // The flow is rescanned: one step reads differently from when the design was pinned.
    const flow = join(root, "specs/forge-orders/forge-orders.place-order.yaml");
    await writeFile(
      flow,
      (await readFile(flow, "utf8")).replace(
        "what: The stock service reserves the quantity",
        "what: The stock service holds the quantity",
      ),
    );
    const file = join(root, "openspec/changes", CHANGE, "change.yaml");
    const path = state === "build" ? ["design", "plan", "build"] : ["design"];
    const moves = path
      .map(
        (to, i) =>
          `  - from: ${i ? path[i - 1] : "define"}
    to: ${to}
    at: 2026-10-2${i + 1}T09:00:00Z
    by: pat
`,
      )
      .join("");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(/^state: .*$/m, `state: ${state}`) + moves,
    );
    const before = calls;
    const again = await architectureStage(root, CHANGE, {
      runtime: deltaRuntime(() => calls++),
      now: NOW,
    });
    return { again, drafted: calls - before };
  }

  it("stays done once the change is in build: its design was built, a rescan doesn't redraft it", async () => {
    const { again, drafted } = await doneThenRescanned("build");
    expect(again.state).toBe("done");
    expect(drafted).toBe(0);
    expect(again.notes.join("\n")).toMatch(
      /Today's flow forge-orders\.place-order changed since this design; the change is in build, so the design stays as it was\./,
    );
  });

  it("drafts again while the change is still in design: the step numbers may point elsewhere", async () => {
    const { drafted } = await doneThenRescanned("design");
    expect(drafted).toBeGreaterThan(0);
  });
});

describe("what a write sends, and where a step may go (M10, A5, M11)", () => {
  const delta = (step: Record<string, unknown>) =>
    FlowDelta.parse({
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The verdict is kept.",
      steps: [{ op: "change", step: 4, what: "Saved", ...step }],
    });
  const rules = async (step: Record<string, unknown>) => {
    const root = await estateRoot();
    const { loadChangeContext } = await import("@maycombhq/changes");
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    return checkDeltas([delta(step)], e, { flows: [], newFlows: [] } as never).map(
      (i) => `${i.rule} ${i.target}`,
    );
  };

  it("reads a qualified field by its last part, and takes a key named under checks as said", async () => {
    const got = await rules({
      kind: "write",
      store: { table: "forge-orders-db.orders", columns: ["sku"] },
      fields: { sends: ["order.sku", "orderId", "fraudVerdict"], checks: ["orderId"] },
    });
    expect(got.filter((r) => r.startsWith("delta.sent-not-stored"))).toEqual([
      "delta.sent-not-stored forge-orders.place-order#1:fraudVerdict",
    ]);
  });

  it("lets a lookup name a target, as the spec template's steps allow; a write may not", async () => {
    const to = { component: "forge-stock", entry: "POST /stock/reservations" };
    expect(
      (await rules({ kind: "lookup", to, fields: { returns: ["sku"] } })).filter((r) =>
        r.startsWith("delta.to-on-store-step"),
      ),
    ).toEqual([]);
    expect(
      (
        await rules({
          kind: "write",
          to,
          store: { table: "forge-orders-db.orders", columns: ["sku"] },
        })
      ).filter((r) => r.startsWith("delta.to-on-store-step")),
    ).toEqual(["delta.to-on-store-step forge-orders.place-order#1"]);
  });
});

describe("a decision a person answered (H5)", () => {
  it("links the question to its finding by id, and stops when the next draft still ignores the answer", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, {
      runtime: new MockRuntime(
        (req) => (req.agent.id.endsWith("-critic") ? "findings: []" : PLACED),
        {
          now: () => NOW,
        },
      ),
      now: NOW,
    });
    // The drafter never classifies the new columns.
    const unclassified = DELTAS.replace(", classification: { verdict: internal }", "").replace(
      ", classification: { fraud_verdict: internal }",
      "",
    );
    let calls = 0;
    const rt = () =>
      new MockRuntime(
        (req: AiRequest) => {
          if (req.agent.id.endsWith("-critic")) return "findings: []";
          calls++;
          return unclassified;
        },
        { now: () => NOW },
      );
    const asked = await architectureStage(root, CHANGE, { runtime: rt(), now: NOW });
    expect(asked.state).toBe("questions");
    const loop = await loopOf(root, "architecture");
    const linked = loop.findings.filter((f) => f.rule === "delta.no-classification");
    expect(linked.length).toBe(2);
    for (const f of linked) expect(asked.questions.map((q) => q.id)).toContain(f.question);
    for (const q of asked.questions)
      await answerQuestion(root, q.id, { option: 2, by: "pat", at: "2026-10-21T10:00:00Z" });
    const before = calls;
    const e = await stopped(architectureStage(root, CHANGE, { runtime: rt(), now: NOW }));
    expect(calls - before).toBe(1);
    expect(e.message).toContain("a person answered");
  });
});

describe("a resume names a run (M5)", () => {
  it("refuses another change's run", async () => {
    const root = await estateRoot();
    const tick = clock();
    const rt = () => new HandoffRuntime({ root, validate: async () => [], now: tick });
    await writeFile(
      join(root, "openspec/changes/bulk-orders/brief.md"),
      "# Bulk orders\n\nA shop owner places many orders at once.\n",
    );
    const other = await featureStage(root, "bulk-orders", {
      runtime: rt(),
      now: tick(),
      force: true,
    });
    expect(other.state).toBe("waiting");
    const e = await featureStage(root, CHANGE, {
      runtime: rt(),
      now: tick(),
      resume: other.waiting!.runId,
    }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PlannerError);
    expect((e as PlannerError).code).toBe("refused");
    expect((e as Error).message).toContain(`isn't a draft or a lens of ${CHANGE}'s feature stage`);
  });
});

describe("a run being written, and a rerun in model mode (L1, L2)", () => {
  it("waits on a run whose run.json doesn't read yet, rather than drafting again", async () => {
    const root = await estateRoot();
    const h = handoff(root);
    const first = await h.step();
    await writeFile(
      join(root, ".runs", CHANGE, first.waiting!.runId, "run.json"),
      '{"runId": "run-',
    );
    const again = await h.step();
    expect(again).toMatchObject({ state: "waiting", drafts: 0, waiting: first.waiting });
  });

  it("drafts again in model mode when the hand-off run it left is checked", async () => {
    const root = await estateRoot();
    const h = handoff(root);
    const first = await h.step();
    await h.answer(first.waiting!.runId, "feature-answer.yaml", PLACED);
    const r = await featureStage(root, CHANGE, {
      runtime: new MockRuntime(
        (req) => (req.agent.id.endsWith("-critic") ? "findings: []" : PLACED),
        {
          now: () => NOW,
        },
      ),
      now: NOW,
    });
    expect(r.state).toBe("done");
  });
});

describe("what a lens is checked against, and what the drafter is given (L3, M1, M4)", () => {
  it("checks a lens's quote against the draft it was given, though the draft changed since", async () => {
    const root = await estateRoot({ lenses: true });
    const h = handoff(root);
    const first = await h.step();
    await h.answer(first.waiting!.runId, "feature-answer.yaml", PLACED);
    const business = (await h.step(first.waiting!.runId)).waiting!;
    await h.answer(business.runId, "findings-business.yaml", "findings: []\n");
    const architecture = (await h.step(business.runId)).waiting!;
    // A person edits feature.md before the lens's answer is read in.
    const md = join(root, "openspec/changes", CHANGE, "feature.md");
    await writeFile(md, (await readFile(md, "utf8")).replace("(read)", "(changed)"));
    await h.answer(architecture.runId, "findings-architecture.yaml", FINDING);
    const r = await h.step(architecture.runId);
    // The finding stands: it quoted what the lens was given.
    expect(r.state).toBe("waiting");
    expect(r.waiting!.lens).toBeUndefined();
    const prompt = await readFile(
      join(root, ".runs", CHANGE, r.waiting!.runId, "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("The critic (flow-use-matches-estate)");
  });

  it("sends feature.yaml as it is on disk, so its lines cite the file's lines", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, {
      runtime: new MockRuntime(
        (req) => (req.agent.id.endsWith("-critic") ? "findings: []" : PLACED),
        {
          now: () => NOW,
        },
      ),
      now: NOW,
    });
    const prompts: string[] = [];
    await architectureStage(root, CHANGE, {
      runtime: new MockRuntime(
        (req) => {
          if (!req.agent.id.endsWith("-critic")) prompts.push(req.pack.prompt);
          return req.agent.id.endsWith("-critic") ? "findings: []" : DELTAS;
        },
        { now: () => NOW },
      ),
      now: NOW,
    });
    const file = await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8");
    expect(prompts[0]).toContain(file.split("\n").slice(0, 3).join("\n"));
  });

  it("gives the drafter the last draft's findings as data, not as Atticus's instructions", async () => {
    const root = await estateRoot();
    const h = handoff(root);
    const first = await h.step();
    await h.answer(
      first.waiting!.runId,
      "feature-answer.yaml",
      PLACED.replace("cap-ordering", "cap-checkout"),
    );
    const second = await h.step(first.waiting!.runId);
    const prompt = await readFile(
      join(root, ".runs", CHANGE, second.waiting!.runId, "prompt.md"),
      "utf8",
    );
    const data = prompt.indexOf('<atticus-data id="hand-backs"');
    expect(data).toBeGreaterThan(-1);
    expect(prompt.indexOf("Feature cap-checkout isn't in the catalog")).toBeGreaterThan(data);
  });
});

// Found on a real metarepo: the stories stage ran while the design gate was stuck (its rounds
// used up, a person deciding). Each stage reads the one before (ADR 0087), so a later stage
// waits for the earlier stage's loop to be done and its gate to pass; it may run before that
// phase's hand-off PR merges, and says so.
describe("a later stage while an earlier stage's gate is stuck", () => {
  const TARGET = "target-flows/forge-orders.place-order.yaml";
  const BRANCH_FINDING = `findings:
  - rule: flow-use-matches-estate
    artifact: ${TARGET}
    summary: The refusal branch reads a verdict before the screen gives one.
    why: A step reads a field no earlier step gives.
    fix: Put the branch after the call-out.
    evidence:
      - { path: ${TARGET}, quote: "kind: branch" }
`;
  const designLimited = (root: string) =>
    writeFile(
      join(root, "org-pack/gates.yaml"),
      `schemaVersion: 2
gates:
  - { id: define, phase: define, approvers: [product-owner], checks: [{ check: openspec-validate }] }
  - { id: design, phase: design, approvers: [architect], maxAuthorRounds: 1, checks: [{ check: openspec-validate }] }
  - { id: plan, phase: plan, approvers: [team-lead], checks: [{ check: openspec-validate }] }
  - { id: build, phase: build, approvers: [developer], checks: [{ check: tests-pass }] }
  - { id: qa, phase: qa, approvers: [qa], checks: [{ check: tests-pass }] }
  - { id: release, phase: release, approvers: [delivery-lead], checks: [{ check: snow-requests-closed }] }
`,
    );
  // The architecture lens finds the branch wrong in every target flow it reads.
  const rt = (draft: string) =>
    new MockRuntime(
      (req: AiRequest) =>
        req.agent.id === "architecture-critic" && req.pack.prompt.includes(TARGET)
          ? BRANCH_FINDING
          : req.agent.id.endsWith("-critic")
            ? "findings: []"
            : draft,
      { now: () => NOW },
    );

  it("the stories stage refuses, naming the architecture stage and the design gate to finish first", async () => {
    const root = await estateRoot({ lenses: true });
    await designLimited(root);
    expect((await featureStage(root, CHANGE, { runtime: rt(PLACED), now: NOW })).state).toBe(
      "done",
    );
    const e = await stopped(architectureStage(root, CHANGE, { runtime: rt(DELTAS), now: NOW }));
    expect(e.message).toContain("the most it allows");
    const refused = await storiesStage(root, CHANGE, { runtime: rt("stories: []"), now: NOW }).then(
      () => undefined,
      (x: unknown) => x as PlannerError,
    );
    expect(refused).toBeInstanceOf(PlannerError);
    expect(refused!.code).toBe("refused");
    expect(refused!.message).toContain(
      "The stories stage can't run yet: the architecture stage isn't finished at the design gate.",
    );
    expect(refused!.message).toContain("atticus change architecture add-fraud-check");
    // Nothing of the stories stage was written.
    await expect(
      readFile(join(root, "openspec/changes", CHANGE, "stage/stories.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("the architecture stage refuses while the feature stage is stopped", async () => {
    const root = await estateRoot();
    expect((await featureStage(root, CHANGE, { runtime: rt(PLACED), now: NOW })).state).toBe(
      "done",
    );
    const file = join(root, "openspec/changes", CHANGE, "stage/feature.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("state: done", "state: stopped"));
    await expect(
      architectureStage(root, CHANGE, { runtime: rt(DELTAS), now: NOW }),
    ).rejects.toThrow(
      "The architecture stage can't run yet: the feature stage isn't finished at the define gate. The feature stage stopped and isn't done",
    );
  });
});
