import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { answerQuestion, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { GAP_STEP, gapQuestion } from "@maycombhq/index";
import {
  ENGINE_DEFAULT,
  featureStage,
  findNeeds,
  GAP_RULE,
  roomFor,
  storiesStage,
} from "../src/index.js";

/**
 * ADR 0107: the steps that sent whole lists select their context with the index instead, behind
 * an option, and say what they left out. The fixtures are the stage tests' two-repo shop with
 * the fraud check's approved placement and target flow (fixtures/context).
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function shop(o: { placed?: boolean; targets?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-engine-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const write = async (dir: string, file: string) => {
    for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const f = join(root, dir, recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  };
  await write("catalog/generated", join(FIX, "specs/catalog.yaml"));
  await write("catalog/generated", join(FIX, "stages/catalog-extra.yaml"));
  await write("knowledge/items", join(FIX, "stages/knowledge.yaml"));
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  const dir = join(root, "openspec/changes", CHANGE);
  if (o.placed)
    await cp(join(FIX, "context/changes/add-fraud-check/feature.yaml"), join(dir, "feature.yaml"));
  if (o.targets)
    await cp(join(FIX, "context/expected/target-flows"), join(dir, "target-flows"), {
      recursive: true,
    });
  return root;
}

const assistant = (answer: string, seen: string[]) =>
  new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      // ADR 0116: the model's reading of the input, when the step asks for it.
      if (req.agent.id === "context-expander") return EXPANDED;
      seen.push(req.pack.prompt);
      return answer;
    },
    { now: () => NOW },
  );

/** What a model reads the fraud check (with its new vendor) as: the name it found, quoted. */
const EXPANDED = `terms: [fraud screen]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: Northwind Pay }
  - { name: Quillfeather Risk, quote: scored by Quillfeather Risk }
`;

const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
`;

describe("the context engine in the steps", () => {
  it("is on by default where the eval allows it", () => {
    expect(ENGINE_DEFAULT).toEqual({
      needs: true,
      feature: true,
      architecture: true,
      stories: true,
    });
  });

  it("feature: selects the estate the brief leads to, and with a tight room says what it left out", async () => {
    const root = await shop();
    const seen: string[] = [];
    const r = await featureStage(root, CHANGE, { runtime: assistant(PLACED, seen), now: NOW });
    expect(r.context?.engine).toBe(true);
    const ids = r.context!.picked.map((p) => p.id);
    for (const id of ["northwind-pay", "cap-ordering", "forge-orders.place-order"])
      expect(ids).toContain(id);
    // The estate's own lines: the stage's checks and the assistant read the same format.
    expect(seen[0]).toContain("flow forge-orders.place-order (repo forge-orders");
    expect(seen[0]).toContain('origin="atticus change feature (context engine)"');

    const tight: string[] = [];
    const t = await featureStage(root, CHANGE, {
      runtime: assistant(PLACED, tight),
      now: NOW,
      force: true,
      context: { tokens: 120 },
    });
    expect(t.context!.tokens).toBeLessThanOrEqual(120);
    expect(t.context!.leftOut.length).toBeGreaterThan(0);
    expect(tight[0]).toContain("left out for room");
  });

  it("feature: with the engine off, sends the whole estate as before", async () => {
    const root = await shop();
    const seen: string[] = [];
    const r = await featureStage(root, CHANGE, {
      runtime: assistant(PLACED, seen),
      now: NOW,
      context: { engine: false },
    });
    expect(r.context).toEqual({ engine: false, picked: [], leftOut: [], unknown: [] });
    expect(seen[0]).toContain('origin="atticus change feature (deterministic)"');
    // Every endpoint, needed or not.
    expect(seen[0]).toContain("endpoint forge-orders.delete-orders-orderid");
  });

  it("needs: sends the items the change leads to, each in full, and says so", async () => {
    const root = await shop({ placed: true, targets: true });
    const seen: string[] = [];
    const r = await findNeeds(root, CHANGE, {
      runtime: assistant("needs: []\nnot_needed: []\n", seen),
      now: NOW,
      maxAttempts: 1,
    });
    expect(r.status).toBe("done");
    expect(r.context?.engine).toBe(true);
    const picked = r.context!.picked.map((p) => p.id);
    expect(picked).toContain("vendor-onboarding");
    expect(picked).toContain("firewall-rule-request");
    // In full: the item as the assistant reads it, with its how-to and lead time.
    expect(seen[0]).toContain("lead_time: 20 working days");

    const whole: string[] = [];
    const w = await findNeeds(root, CHANGE, {
      runtime: assistant("needs: []\nnot_needed: []\n", whole),
      now: NOW,
      maxAttempts: 1,
      context: { engine: false },
    });
    expect(w.context?.engine).toBe(false);
    for (const id of ["firewall-rule-request", "broker-topic-request", "vendor-onboarding"])
      expect(whole[0]).toContain(`id="item-${id}"`);
  });

  it("stories: the processes the target flows call for, in the stage's own lines", async () => {
    const root = await shop({ placed: true, targets: true });
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant("stories: []\nrequests: []\n", seen),
      now: NOW,
    }).catch(() => undefined);
    expect(seen[0]).toContain(
      'request firewall-rule-request "Network firewall rule": applies when',
    );
    expect(seen[0]).toContain('process vendor-onboarding "Vendor onboarding": applies when');
    expect(seen[0]).not.toContain("broker-topic-request");
    expect(r === undefined || r.context?.engine === true).toBe(true);
  });

  // ADR 0107 point 5: what neither the wikis nor the repos say.
  describe("gaps", () => {
    const withGap = async () => {
      const root = await shop({ placed: true, targets: true });
      const brief = join(root, "openspec/changes", CHANGE, "brief.md");
      const text = readFileSync(brief, "utf8");
      await writeFile(brief, `${text}\nEvery order is also scored by Quillfeather Risk.\n`);
      const line = `${text}\nEvery order is also scored by Quillfeather Risk.\n`
        .split("\n")
        .findIndex((l) => l.includes("Quillfeather"));
      return { root, evidence: `openspec/changes/${CHANGE}/brief.md:${line + 1}` };
    };

    it("feature: lists a gap, tells the model not to guess, and asks a person when the answer relies on it", async () => {
      const { root, evidence } = await withGap();
      const seen: string[] = [];
      const answer = `${PLACED}gaps:\n  - { what: Quillfeather Risk scores the order, why: no flow calls it }\nrelies_on_gaps: [Quillfeather Risk]\n`;
      const r = await featureStage(root, CHANGE, {
        runtime: assistant(answer, seen),
        now: NOW,
        context: { expand: true },
      });
      expect(seen[0]).toContain(GAP_RULE);
      expect(seen[0]).toMatch(
        /origin="context-gaps">\nNames the change uses that nothing Atticus has read says anything about:\n- Quillfeather Risk/,
      );
      const gap = r.context?.gaps?.find((g) => g.name === "Quillfeather Risk");
      expect(gap).toMatchObject({ evidence, state: "asked" });
      expect(r.state).toBe("questions");
      const q = r.questions.find((x) => x.id === gap!.question)!;
      expect(q.question).toBe(gapQuestion("Quillfeather Risk"));
      expect(q.askedBy.step).toBe(GAP_STEP);
      expect(q.repo).toBe(CHANGE);
      expect(q.evidence).toEqual([evidence]);

      // Answered, the gap is asserted knowledge: indexed, known, and in the next pack.
      await answerQuestion(root, q.id, {
        text: "A risk-scoring vendor the payments team is trialling; not onboarded yet.",
        by: "sam",
        at: "2026-10-21T10:00:00Z",
      });
      const again: string[] = [];
      const r2 = await featureStage(root, CHANGE, {
        runtime: assistant(answer, again),
        now: NOW,
        force: true,
        context: { expand: true },
      });
      expect(r2.context?.gaps ?? []).toEqual([]);
      expect(again[0]).toMatch(
        /- Quillfeather Risk: A risk-scoring vendor the payments team is trialling; not onboarded yet. \(sam, 2026-10-21T10:00:00Z, question q-/,
      );
      expect(r2.state).toBe("done");
    });

    it("feature: a gap the answer doesn't rely on is listed, not asked, even when it names it", async () => {
      const { root } = await withGap();
      // Named, but not relied on: the old substring rule asked a person about it.
      const r = await featureStage(root, CHANGE, {
        runtime: assistant(
          `${PLACED}gaps:\n  - { what: "Quillfeather Risk is not in the catalog, so the plan leaves it out", why: out of scope }\n`,
          [],
        ),
        now: NOW,
        context: { expand: true },
      });
      expect(r.context?.gaps).toEqual([
        expect.objectContaining({ name: "Quillfeather Risk", state: "listed" }),
      ]);
      expect(r.state).toBe("done");
      expect(r.questions).toEqual([]);
    });

    it("needs: the same gap is one question, whichever step meets it first", async () => {
      const { root } = await withGap();
      const r = await findNeeds(root, CHANGE, {
        runtime: assistant("needs: []\nnot_needed: []\nrelies_on_gaps: [quillfeather risk]\n", []),
        now: NOW,
        maxAttempts: 1,
        context: { expand: true },
      });
      expect(r.status).toBe("done");
      expect(r.questions?.map((q) => q.question)).toEqual([gapQuestion("Quillfeather Risk")]);
      const f = await featureStage(root, CHANGE, {
        runtime: assistant(`${PLACED}relies_on_gaps: [Quillfeather Risk]\n`, []),
        now: NOW,
        context: { expand: true },
      });
      expect(f.questions.map((q) => q.id)).toEqual(r.questions!.map((q) => q.id));
    });
  });

  it("leaves room for the step's own input and a reserve, or what --context-tokens says", () => {
    const others = [
      {
        id: "a",
        kind: "document" as const,
        origin: "x",
        text: "y".repeat(4000),
        classification: "internal",
      },
    ];
    const room = roomFor(10_000, others);
    expect(room).toBeLessThanOrEqual(8000);
    // 10,000 less the input (1,000 and its wrapper) less a tenth for later drafts.
    expect(room).toBeGreaterThan(7900);
    expect(roomFor(10_000, others, { tokens: 500 })).toBe(500);
    expect(roomFor(100, others)).toBe(0);
  });
});
