import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, readQuestion, recordPath, serializeRecord } from "@maycombhq/core";
import { act, readRound, roundsOf } from "@maycombhq/naysayer";
import {
  ACCEPTABLE_STAGE_RULES,
  EXPAND_AGENT,
  featureStage,
  issueFingerprint,
  readAccepted,
  retireChangeEscalations,
  stageFinding,
  wayOn,
  type LoopFinding,
} from "../src/index.js";

/**
 * ADR 0203 A: a person may accept a stage's blocking finding. Each rule of the ADR's table by
 * name; the projection onto the stage's gate; who may accept; and the feature stage on the small
 * Forge estate, run again after an acceptance: done with no new draft. A mock model; no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const NOW = new Date("2026-11-19T09:00:00Z");
const CHANGE = "add-fraud-check";

/** The ADR's table: the rules a person may accept, and some of each row that they may not. */
const YES = [
  "feature.unknown-repo",
  "operation.unknown-repo",
  "delta.unknown-component",
  "delta.unknown-entry",
  "delta.unknown-consumer",
  "stories.unknown-consumer",
  "delta.consumer-missing",
  "delta.new-folder",
  "stories.field-not-checked",
  "stories.field-no-validation",
  "stories.field-no-error-case",
  "stories.shape-uncovered",
];
const NO: [string, string][] = [
  ["feature.unknown-flow", "The next stage needs today's steps"],
  ["delta.unknown-column", "The next stage needs today's steps"],
  ["stories.unknown-entry", "The next stage needs today's steps"],
  ["delta.exists", "a document never overrides one (rule 6)"],
  ["delta.stale", "a document never overrides one (rule 6)"],
  ["delta.no-classification", "It is about data safety"],
  ["stories.write-no-migration", "It is about data safety"],
  ["delta.at-unknown", "The place cites code that isn't there"],
  ["delta.uses-no-line", "The place cites code that isn't there"],
  ["delta.key-unknown-column", "a wrong order is not a matter of opinion"],
  ["delta.deploy-order", "a wrong order is not a matter of opinion"],
  ["operation.no-undo", "a wrong order is not a matter of opinion"],
  ["operation.order", "a wrong order is not a matter of opinion"],
  ["stories.note-overrides-code", "A document never overrides a fact verified from code"],
  ["feature.nothing-placed", "belongs on the quick path"],
  ["small.no-target-flow", "belongs on the quick path"],
  ["stage.format", "The answer doesn't read"],
  ["design.unmapped", "The answer doesn't read, or a design element is unmapped"],
  ["delta.empty", "The next stage can't do its work with it open"],
  ["stories.no-criteria", "The next stage can't do its work with it open"],
];

const loopFinding = (rule: string, target: string, message: string): LoopFinding => ({
  fingerprint: issueFingerprint(rule, target),
  rule,
  target,
  message,
  blocking: true,
  source: "stage",
  seenIn: [1],
});
const opts = {
  change: CHANGE,
  stage: "architecture" as const,
  source: "target-flows/",
  rerun: `atticus change architecture ${CHANGE}`,
  now: "2026-11-19T09:00:00Z",
};

describe("which stage rules a person may accept (ADR 0203 A.3)", () => {
  it("is exactly the table's list", () => {
    expect([...ACCEPTABLE_STAGE_RULES].sort()).toEqual([...YES].sort());
  });

  it.each(YES)("%s is projected as a blocking C3 finding a person may waive", async (rule) => {
    const f = await stageFinding(loopFinding(rule, "orders:forge-ghost", "Not known."), opts);
    expect(f).toMatchObject({
      id: `stage-${issueFingerprint(rule, "orders:forge-ghost")}`,
      gate: "stage-architecture",
      rule,
      layer: "org",
      lens: rule.startsWith("stories.") ? "complete" : "true",
      severity: "blocking",
      artifact: "target-flows/",
      waivable: true,
      state: "open",
    });
    expect(f.fix.text).toBe(
      `Fix target-flows/ and run atticus change architecture ${CHANGE} again. Or accept it: atticus finding ${CHANGE} ${f.id} waive --reason "<why>".`,
    );
  });

  it.each(NO)("%s is projected as not waivable, with its row's way on", async (rule, words) => {
    const f = await stageFinding(loopFinding(rule, "orders#2", "Wrong."), opts);
    expect(f.waivable).toBe(false);
    expect(f.fix.text).toContain(" It can't be accepted: ");
    expect(wayOn(rule)).toContain(words);
    expect(f.fix.text).toContain(wayOn(rule));
  });

  it("names the id a rule about one id is about, for the later stages", async () => {
    const consumer = await stageFinding(
      loopFinding("delta.unknown-consumer", "forge-orders.place-order:forge-ghost", "No."),
      opts,
    );
    expect(consumer.locator).toEqual({
      heading: "forge-orders.place-order:forge-ghost",
      record: "forge-ghost",
    });
    const component = await stageFinding(
      loopFinding(
        "delta.unknown-component",
        "forge-orders.place-order#3",
        "Change 3 to forge-orders.place-order goes to forge-ghost, which the catalog doesn't have; use an id from the index, or new: true.",
      ),
      opts,
    );
    expect(component.locator.record).toBe("forge-ghost");
  });
});

// ------------------------------------------------------------------ the feature stage

const MANIFEST = `schemaVersion: 1
platform: forge
repos:
  - id: forge-orders
    url: https://git.example.com/forge/forge-orders.git
    type: spring-boot
    owner: team-orders
`;

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-accept-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/repos.manifest.yaml"), MANIFEST);
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

/** A drafter that answers the same draft every time, and counts its drafts. */
function assistant(draft: string) {
  const drafts: string[] = [];
  const runtime = new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      drafts.push(req.agent.id);
      return draft;
    },
    { now: () => NOW },
  );
  return { runtime, drafts };
}

const placed = (
  repo: string,
) => `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
newFlows:
  - { name: Screening queue, repo: ${repo}, why: The screen needs a queue. }
`;

const stageGate = async (root: string) => {
  const n = (await roundsOf(root, CHANGE, "stage-feature")).at(-1)!;
  return (await readRound(root, CHANGE, "stage-feature", n)).findings.map((s) => s.finding);
};

describe("accepting the feature stage's finding about a repo the estate doesn't have", () => {
  it("projects it, refuses an assistant, takes a person's, and the stage run again is done with no new draft", async () => {
    const root = await estateRoot();
    const first = assistant(placed("forge-screening"));
    const r = await featureStage(root, CHANGE, { runtime: first.runtime, now: NOW });
    // Three drafts in a row had it: a person's question.
    expect(r.state).toBe("questions");
    const [f] = await stageGate(root);
    expect(f).toMatchObject({ rule: "feature.unknown-repo", waivable: true, state: "open" });
    expect(f!.locator.record).toBe("forge-screening");

    // Only a person accepts.
    await expect(
      act(root, CHANGE, f!.id, "waive", { by: "claude", reason: "It is new." }),
    ).rejects.toThrow(/is an assistant: only a person waives a finding/);
    await act(root, CHANGE, f!.id, "waive", {
      by: "pat",
      reason: "The screening repo is created this week",
      now: "2026-11-19T10:00:00Z",
    });
    expect([...(await readAccepted(root, CHANGE)).values()]).toEqual([
      expect.objectContaining({
        rule: "feature.unknown-repo",
        by: "pat",
        record: "forge-screening",
      }),
    ]);
    // The question it became is answered with the acceptance's words.
    await retireChangeEscalations(root, CHANGE, "2026-11-19T10:00:00Z");
    const q = await readQuestion(root, r.questions[0]!.id);
    expect(q?.state).toBe("answered");
    expect(q?.answer?.text).toBe("Accepted: The screening repo is created this week");

    const again = assistant(placed("forge-screening"));
    const done = await featureStage(root, CHANGE, { runtime: again.runtime, now: NOW });
    expect(done.state).toBe("done");
    expect(again.drafts).toEqual([]);
    // The finding keeps its file and its acceptance.
    expect((await stageGate(root))[0]).toMatchObject({ id: f!.id, state: "waived" });

    // A redraft that names another repo is a new finding, open.
    const other = assistant(placed("forge-queue"));
    await featureStage(root, CHANGE, { runtime: other.runtime, now: NOW, force: true });
    const now = await stageGate(root);
    expect(now.map((x) => [x.locator.record, x.state])).toContainEqual(["forge-queue", "open"]);
  });

  it("refuses to accept a rule not on the list, saying the row's way on", async () => {
    const root = await estateRoot();
    const r = assistant("summary: A move of the order services to another platform.\n");
    await featureStage(root, CHANGE, { runtime: r.runtime, now: NOW }).catch(() => undefined);
    const [f] = await stageGate(root);
    expect(f).toMatchObject({ rule: "feature.nothing-placed", waivable: false });
    await expect(
      act(root, CHANGE, f!.id, "waive", { by: "pat", reason: "We know better." }),
    ).rejects.toThrow(
      `${f!.id} (rule feature.nothing-placed) can't be accepted. Nothing is left to plan, so accepting it can't work`,
    );
    const text = await readFile(
      join(root, "openspec/changes", CHANGE, "review/stage-feature/1", `${f!.id}.yaml`),
      "utf8",
    );
    expect(text).toContain("state: open");
  });
});
