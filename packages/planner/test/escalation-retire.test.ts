import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, readQuestion, recordPath, serializeRecord } from "@maycombhq/core";
import { act, gateStatus } from "@maycombhq/naysayer";
import { featureStage, retireChangeEscalations } from "../src/index.js";

/**
 * Ninth UX walk: a critic finding three drafts in a row had becomes a person's question ("Three
 * drafts in a row had this problem"). Once a person dismisses the finding, or a draft no longer
 * has it, the question asks about nothing: it is retired, saying why, and the stage carries on.
 */

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

/** A lens finds the flow marked read while a line of what it was given still says so. */
const truthLens = (prompt: string) =>
  /\n\d+: .*Flow forge-stock\.reserve-stock \(read\)/.test(prompt) ? FINDING : "findings: []";

const runtime = () =>
  new MockRuntime(
    (req: AiRequest) =>
      req.agent.id.endsWith("-critic")
        ? req.agent.id === "true-critic"
          ? truthLens(req.pack.prompt)
          : "findings: []"
        : PLACED,
    { now: () => NOW },
  );

describe("the stage's escalation question about a critic finding", () => {
  it("is retired, with why, when a person dismisses the finding, and the stage carries on", async () => {
    const root = await estateRoot();
    const r = await featureStage(root, CHANGE, { runtime: runtime(), now: NOW });
    expect(r.state).toBe("questions");
    const q = r.questions.find((x) => x.question.startsWith("Three drafts in a row"))!;
    expect(q).toBeDefined();
    const f = (await gateStatus(root, CHANGE, "define")).findings.find(
      (x) => x.finding.rule === "flow-use-matches-estate",
    )!.finding;
    await act(root, CHANGE, f.id, "not-relevant", {
      by: "pat",
      reason: "Reserving stock only reads the verdict.",
    });
    const again = await featureStage(root, CHANGE, { runtime: runtime(), now: NOW });
    const retired = (await readQuestion(root, q.id))!;
    expect(retired.state).toBe("retired");
    expect(retired.retired?.why).toMatch(/dismissed as not relevant by pat/);
    expect(again.questions.map((x) => x.id)).not.toContain(q.id);
    expect(again.state).toBe("done");
  });

  it("is retired as soon as the person acts, before the stage runs again", async () => {
    const root = await estateRoot();
    const r = await featureStage(root, CHANGE, { runtime: runtime(), now: NOW });
    const q = r.questions.find((x) => x.question.startsWith("Three drafts in a row"))!;
    const f = (await gateStatus(root, CHANGE, "define")).findings.find(
      (x) => x.finding.rule === "flow-use-matches-estate",
    )!.finding;
    expect(await retireChangeEscalations(root, CHANGE, "2026-10-21T10:00:00Z")).toEqual([]);
    await act(root, CHANGE, f.id, "not-relevant", { by: "pat", reason: "Only read." });
    expect(await retireChangeEscalations(root, CHANGE, "2026-10-21T10:00:00Z")).toEqual([
      "feature",
    ]);
    expect((await readQuestion(root, q.id))?.retired).toMatchObject({
      at: "2026-10-21T10:00:00Z",
      why: `Its critic finding ${f.id} was dismissed as not relevant by pat: Only read.`,
    });
  });
});
