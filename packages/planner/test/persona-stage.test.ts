import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  HandoffRuntime,
  MockRuntime,
  type AiRequest,
  type AiRuntime,
  type Run,
} from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { readRound, readRoundMeta, roundsOf } from "@maycombhq/naysayer";
import { EXPAND_AGENT, featureStage } from "../src/index.js";

/**
 * ADR 0203 C, the owner's decision of 2026-11-21: a persona lens never holds a gate, nor a
 * stage. A persona's naysayer runs at the feature stage's gate and is handed to the person's
 * assistant; the four questions answer at once. The stage doesn't wait for the persona: it is
 * done, and the persona's lens stays on file, waiting, to be read in when it comes. Invented
 * Forge names; a mock model and a hand-off runtime; no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const NOW = new Date("2026-11-21T09:00:00Z");
const CHANGE = "add-fraud-check";
const NAYSAYER = "orders-architect-naysayer";

const MANIFEST = `schemaVersion: 1
platform: forge
repos:
  - id: forge-orders
    url: https://git.example.com/forge/forge-orders.git
    type: spring-boot
    owner: team-orders
`;

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-persona-stage-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await mkdir(join(root, "org-pack/agents"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/repos.manifest.yaml"), MANIFEST);
  await writeFile(
    join(root, "org-pack/agents", `${NAYSAYER}.md`),
    `---\nname: ${NAYSAYER}\ndescription: Asks what the orders section left out.\nrole: architect\nowns: Orders architect\ngates: [define, design, plan]\n---\n\nAsk who else reads an order before stock is reserved.\n`,
  );
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
newFlows: []
`;

/** The model answers everything at once; the persona's naysayer goes to the assistant. */
class SplitRuntime implements AiRuntime {
  readonly kind = "mock" as const;
  private readonly of = new Map<string, AiRuntime>();
  readonly handed: string[] = [];
  constructor(
    private readonly model: AiRuntime,
    private readonly handoff: AiRuntime,
  ) {}
  async prepare(request: AiRequest): Promise<Run> {
    const rt = request.agent.id === NAYSAYER ? this.handoff : this.model;
    const run = await rt.prepare(request);
    this.of.set(run.runId, rt);
    if (rt === this.handoff) this.handed.push(run.runId);
    return run;
  }
  run(runId: string, signal?: AbortSignal): Promise<Run> {
    return this.of.get(runId)!.run(runId, signal);
  }
  result(runId: string): Promise<Run> {
    return (this.of.get(runId) ?? this.handoff).result(runId);
  }
}

describe("a stage never waits for a persona lens (ADR 0203 C)", () => {
  it("is done while the persona's naysayer is still with the assistant, which stays on file", async () => {
    const root = await estateRoot();
    const model = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        return PLACED;
      },
      { now: () => NOW },
    );
    const handoff = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const runtime = new SplitRuntime(model, handoff);
    const r = await featureStage(root, CHANGE, { runtime, now: NOW });
    // The persona's naysayer was asked, and handed off.
    expect(runtime.handed).toHaveLength(1);
    expect(r.state).toBe("done");
    expect(r.waiting).toBeUndefined();
    // Its lens is on file, waiting, so its answer can be read in when it comes.
    const gate = "define";
    const n = (await roundsOf(root, CHANGE, gate)).at(-1)!;
    const meta = await readRoundMeta(root, CHANGE, gate, n);
    expect(meta?.lenses.find((l) => l.persona === NAYSAYER)).toMatchObject({
      state: "waiting",
      runId: runtime.handed[0],
    });
  });
});

// ------------------------------------------------------------- a redraft's carry, through the critic

const STAGES = join(FIX, "stages");
const naysayerFile = (gates: string) =>
  `---\nname: ${NAYSAYER}\ndescription: Asks what the orders section left out.\nrole: architect\nowns: Orders architect\n${gates}---\n\nAsk who else reads an order before stock is reserved.\n`;

/** The critic-rounds estate: the recorded Forge stage fixture with the lens checklists. */
async function lensRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-persona-carry-"));
  await mkdir(join(root, "org-pack/agents"), { recursive: true });
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\nretrieval: { expansion: false }\n",
  );
  await writeFile(
    join(root, "org-pack/agents", `${NAYSAYER}.md`),
    naysayerFile("gates: [define]\n"),
  );
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const [under, list] of [
    ["catalog/generated", rows],
    ["knowledge/items", parse(readFileSync(join(STAGES, "knowledge.yaml"), "utf8")) as unknown[]],
  ] as const)
    for (const r of list) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error("bad fixture record");
      const f = join(root, under, recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(STAGES, "lenses/checklists"), join(root, "org-pack/checklists"), {
    recursive: true,
  });
  return root;
}

const DRAFT = `summary: Every new order is screened by Northwind Pay before stock is reserved; a rejected order is refused.
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
const TRUTH = `findings:
  - rule: flow-use-matches-estate
    artifact: feature.md
    summary: Reserving stock now waits for the screen's verdict, so its steps change.
    why: A flow marked read gets no target flow.
    fix: Mark forge-stock.reserve-stock as changed.
    evidence:
      - { path: feature.md, quote: "Flow forge-stock.reserve-stock (read)" }
`;
const ORDERS_LINE = "Flow forge-orders.place-order (changed)";

/**
 * Draft 2 is reviewed whole: the true lens finds the flow marked read, and the persona asks about
 * the place-order line, which draft 3 doesn't change. Draft 3's round carries what its part didn't
 * change, for the lenses that run: the persona's finding while its naysayer still runs at the gate,
 * and not once its file no longer gives the gate.
 */
async function threeDrafts(root: string, o: { dropPersonaAt3: boolean }) {
  let draft = 0;
  const model = new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id === NAYSAYER) {
        const line = new RegExp(`\\n(\\d+): - ${ORDERS_LINE.replace(/[()]/g, "\\$&")}`).exec(
          req.pack.prompt,
        )?.[1];
        if (draft !== 2 || !line) return "findings: []";
        return [
          "findings:",
          `  - rule: persona.${NAYSAYER}`,
          "    kind: issue",
          "    artifact: feature.md",
          `    locator: { line: ${line} }`,
          "    summary: Nothing says who else reads an order before stock is reserved.",
          "    why: Another reader would see an order the screen hasn't passed.",
          "    fix: Name every reader of the order before the screen.",
          "    evidence:",
          `      - { path: feature.md, line: ${line}, quote: "${ORDERS_LINE}" }`,
          "",
        ].join("\n");
      }
      if (req.agent.id.endsWith("-critic"))
        return req.agent.id === "true-critic" &&
          /\n\d+: .*Flow forge-stock\.reserve-stock \(read\)/.test(req.pack.prompt)
          ? TRUTH
          : "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      draft++;
      if (draft === 1) return DRAFT.replace("cap-ordering", "cap-checkout");
      if (draft === 2) return DRAFT;
      if (o.dropPersonaAt3)
        writeFileSync(join(root, "org-pack/agents", `${NAYSAYER}.md`), naysayerFile(""));
      return DRAFT.replace("how: read", "how: changed");
    },
    { now: () => NOW },
  );
  const r = await featureStage(root, CHANGE, { runtime: model, now: NOW });
  const rounds = await roundsOf(root, CHANGE, "define");
  const persona = async (n: number) =>
    (await readRound(root, CHANGE, "define", n)).findings
      .map((x) => x.finding)
      .filter((f) => f.lens === "persona");
  return { r, rounds, persona };
}

describe("a redraft carries a persona's finding through the critic only while its lens runs", () => {
  it("carries it while the persona's naysayer still runs at the gate", async () => {
    const root = await lensRoot();
    const { rounds, persona } = await threeDrafts(root, { dropPersonaAt3: false });
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect((await persona(1)).map((f) => f.persona)).toEqual([NAYSAYER]);
    // The round of draft 3 reviewed only the diff, and carried the persona's finding.
    const meta = await readRoundMeta(root, CHANGE, "define", 2);
    expect(meta?.lenses.find((l) => l.lens === "true")?.context).toMatchObject({ since: 1 });
    expect((await persona(2)).map((f) => f.persona)).toEqual([NAYSAYER]);
  });

  it("drops it once the persona's file no longer gives the gate", async () => {
    const root = await lensRoot();
    const { persona } = await threeDrafts(root, { dropPersonaAt3: true });
    expect((await persona(1)).map((f) => f.persona)).toEqual([NAYSAYER]);
    expect(await persona(2)).toEqual([]);
  });
});
