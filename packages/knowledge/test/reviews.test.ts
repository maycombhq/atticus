import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack } from "@maycombhq/core";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  planRescan,
  readKnowledge,
  readSnapshot,
  reviewItem,
  scanKnowledge,
  syncSources,
  writeKnowledge,
  writeReview,
  writeSnapshots,
} from "../src/index.js";

/**
 * ADR 0101: a person verifies, corrects or rejects what the knowledge scan read, and a rescan
 * reads only the pages that changed, keeps the ids of items still there and says what changed.
 */

const KAFKA = `# Request a Kafka topic

## The request

When: a service will publish to or consume from a topic that does not exist yet.

Raise the Kafka topic change task. Handled by: Messaging team. Lead time: 5 working days.
`;
const SSO = `# Set up SSO

## Intake

When: a new web application needs single sign-on.

Fill in the SSO intake form. Handled by: Identity team. Lead time: 10 working days.
`;

const answer = (o: { kafkaWhen?: string; sso?: boolean; vendor?: boolean } = {}) => `items:
  - kind: request
    id: kafka-topic-request
    title: Kafka topic
    applies_when: ${o.kafkaWhen ?? "A service will publish to or consume from a topic that does not exist yet."}
    lead_time: 5 working days
    handled_by: Messaging team
    source: { page: how-to/kafka.md, section: The request, quote: "Handled by: Messaging team. Lead time: 5 working days." }
${
  o.sso === false
    ? ""
    : `  - kind: request
    id: sso-intake
    title: SSO intake
    applies_when: A new web application needs single sign-on.
    lead_time: 10 working days
    handled_by: Identity team
    source: { page: how-to/sso.md, section: Intake, quote: "Handled by: Identity team. Lead time: 10 working days." }
`
}`;

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "atticus-reviews-"));
  const wiki = join(base, "wiki");
  await mkdir(join(wiki, "how-to"), { recursive: true });
  await writeFile(join(wiki, "how-to", "kafka.md"), KAFKA);
  await writeFile(join(wiki, "how-to", "sso.md"), SSO);
  const root = join(base, "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 1\nwikis:\n  - { id: platform, type: markdown-folder, location: ${JSON.stringify(wiki.split("\\").join("/"))} }\n`,
  );
  return { base, wiki, root };
}

async function sync(root: string, now: string) {
  const op = await loadOrgPack(join(root, "org-pack"));
  const s = await syncSources({ root, orgPack: op, orgPackDir: join(root, "org-pack"), now });
  await writeSnapshots({ root, orgPack: op, sync: s, takenAt: now });
  return (await readSnapshot(root, "platform"))!;
}

async function scanned() {
  const m = await metarepo();
  const snap = await sync(m.root, "2026-10-20T09:00:00Z");
  const r = await scanKnowledge([snap], {
    runtime: new MockRuntime(() => answer()),
    now: new Date("2026-10-20T09:00:00Z"),
  });
  await writeKnowledge(m.root, r, "2026-10-20T09:00:00Z", { snapshots: [snap] });
  return m;
}

describe("a person reviews what the scan read", () => {
  it("verifies an item: it carries who did and when, a green tick wherever it shows", async () => {
    const { root } = await scanned();
    const k = await readKnowledge(root);
    const item = k.items.find((i) => i.id === "kafka-topic-request")!;
    const r = reviewItem(item, {
      verdict: "verified",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
    });
    if ("error" in r) throw new Error(r.error);
    await writeReview(root, r.review);
    const after = await readKnowledge(root);
    expect(after.reviews["kafka-topic-request"]).toMatchObject({
      state: "verified",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
    });
    expect(after.reviews["sso-intake"]).toBeUndefined();
  });

  it("corrects an item's details: the corrected values are what everyone reads", async () => {
    const { root } = await scanned();
    const item = (await readKnowledge(root)).items.find((i) => i.id === "kafka-topic-request")!;
    const r = reviewItem(item, {
      verdict: "corrected",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
      note: "The catalogue item was renamed.",
      set: {
        catalogueItem: "CTASK: Kafka topic (platform catalogue)",
        leadTime: "3 working days",
        steps: [
          "Open the platform catalogue",
          "Pick Kafka topic",
          "Name the producers and consumers",
        ],
      },
    });
    if ("error" in r) throw new Error(r.error);
    await writeReview(root, r.review);
    const after = await readKnowledge(root);
    const fixed = after.items.find((i) => i.id === "kafka-topic-request")!;
    expect(fixed).toMatchObject({
      catalogueItem: "CTASK: Kafka topic (platform catalogue)",
      leadTime: "3 working days",
      steps: [
        "Open the platform catalogue",
        "Pick Kafka topic",
        "Name the producers and consumers",
      ],
    });
    expect(after.reviews["kafka-topic-request"]).toMatchObject({
      state: "corrected",
      note: "The catalogue item was renamed.",
      corrected: ["catalogueItem", "leadTime", "steps"],
    });
    // The scan's own record stays as the scan read it.
    expect(
      (await readKnowledge(root, { raw: true })).items.find((i) => i.id === item.id),
    ).toMatchObject({
      leadTime: "5 working days",
    });
  });

  // B2 (h): the scan's answer writes lead_time, the record leadTime; a person may type either.
  it("takes a field by the scan's name too (lead_time), and writes the record's (leadTime)", async () => {
    const { root } = await scanned();
    const item = (await readKnowledge(root)).items.find((i) => i.id === "kafka-topic-request")!;
    const r = reviewItem(item, {
      verdict: "corrected",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
      set: { lead_time: "3 working days", handled_by: "Platform team" },
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.review.corrections).toEqual({
      leadTime: "3 working days",
      handledBy: "Platform team",
    });
    expect(r.item).toMatchObject({ leadTime: "3 working days", handledBy: "Platform team" });
    expect(r.item).not.toHaveProperty("lead_time");
    // A name that is no field in either form is still refused, by the name the person typed.
    expect(
      reviewItem(item, {
        verdict: "corrected",
        by: "T",
        at: "2026-10-21T10:00:00Z",
        set: { lead_colour: "x" },
      }),
    ).toMatchObject({ error: expect.stringContaining("A request has no field lead_colour") });
  });

  it("refuses a correction to what the page quoted, or a field the kind hasn't", async () => {
    const { root } = await scanned();
    const item = (await readKnowledge(root)).items.find((i) => i.id === "kafka-topic-request")!;
    const at = "2026-10-21T10:00:00Z";
    expect(
      reviewItem(item, { verdict: "corrected", by: "T", at, set: { quote: "x" } }),
    ).toMatchObject({
      error: expect.stringContaining("quote can't be corrected"),
    });
    expect(
      reviewItem(item, { verdict: "corrected", by: "T", at, set: { colour: "x" } }),
    ).toMatchObject({
      error: expect.stringContaining("A request has no field colour"),
    });
    expect(reviewItem(item, { verdict: "corrected", by: "T", at })).toMatchObject({
      error: expect.stringContaining("Say what to correct"),
    });
  });

  it("rejects an item: it is left out of what plans and answers read, and still listed as rejected", async () => {
    const { root } = await scanned();
    const item = (await readKnowledge(root)).items.find((i) => i.id === "sso-intake")!;
    const r = reviewItem(item, {
      verdict: "rejected",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
      note: "SSO is set up by the platform now.",
    });
    if ("error" in r) throw new Error(r.error);
    await writeReview(root, r.review);
    const after = await readKnowledge(root);
    expect(after.items.map((i) => i.id)).toEqual(["kafka-topic-request"]);
    expect(after.rejected.map((i) => i.id)).toEqual(["sso-intake"]);
    expect(after.reviews["sso-intake"]!.state).toBe("rejected");
  });

  it("asks for a reason to reject", async () => {
    const { root } = await scanned();
    const item = (await readKnowledge(root)).items[0]!;
    expect(
      reviewItem(item, { verdict: "rejected", by: "T", at: "2026-10-21T10:00:00Z" }),
    ).toMatchObject({
      error: expect.stringContaining("Say why"),
    });
  });
});

describe("a rescan", () => {
  it("reads only the pages that changed, keeps the rest, and says what changed", async () => {
    const { root, wiki } = await scanned();
    const item = (await readKnowledge(root)).items.find((i) => i.id === "kafka-topic-request")!;
    const v = reviewItem(item, {
      verdict: "verified",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
    });
    if ("error" in v) throw new Error(v.error);
    await writeReview(root, v.review);

    await writeFile(
      join(wiki, "how-to", "kafka.md"),
      KAFKA.replace(
        "does not exist yet.",
        "does not exist yet, in any environment above development.",
      ),
    );
    const snap = await sync(root, "2026-10-22T09:00:00Z");
    const before = await readKnowledge(root, { raw: true });
    const plan = planRescan([snap], before.report, before.items);
    expect(plan.changed).toEqual({ platform: ["how-to/kafka.md"] });
    expect(plan.unchanged).toEqual({ platform: 1 });
    expect(plan.snapshots[0]!.pages.map((p) => p.pagePath)).toEqual(["how-to/kafka.md"]);
    expect(plan.previous.map((i) => i.id)).toEqual(["kafka-topic-request"]);

    const prompts: string[] = [];
    const runtime = new MockRuntime((r: AiRequest) => {
      prompts.push(r.pack.prompt);
      return answer({
        kafkaWhen:
          "A service will use a topic that does not exist yet, in any environment above development.",
        sso: false,
      });
    });
    const r = await scanKnowledge(plan.snapshots, {
      runtime,
      now: new Date("2026-10-22T09:00:00Z"),
      previous: plan.previous,
    });
    // The AI is shown the item it read from that page before, to keep its id.
    expect(prompts[0]).toContain("kafka-topic-request");
    expect(prompts[0]).not.toContain("Fill in the SSO intake form");
    const w = await writeKnowledge(root, r, "2026-10-22T09:00:00Z", { snapshots: [snap], plan });
    expect(w.changes).toEqual({ added: [], changed: ["kafka-topic-request"], removed: [] });

    const after = await readKnowledge(root);
    expect(after.items.map((i) => i.id).sort()).toEqual(["kafka-topic-request", "sso-intake"]);
    // The page under a verified item changed: its tick waits for a person again.
    expect(after.reviews["kafka-topic-request"]!.state).toBe("stale");
    expect(after.report!.changes).toMatchObject({
      at: "2026-10-22T09:00:00Z",
      changed: ["kafka-topic-request"],
    });
  });

  it("drops the items of a page that is gone, and has nothing to read when nothing changed", async () => {
    const { root, wiki } = await scanned();
    const same = await sync(root, "2026-10-22T09:00:00Z");
    const k = await readKnowledge(root, { raw: true });
    expect(planRescan([same], k.report, k.items).snapshots).toEqual([]);

    await rm(join(wiki, "how-to", "sso.md"));
    const snap = await sync(root, "2026-10-23T09:00:00Z");
    const k2 = await readKnowledge(root, { raw: true });
    const plan = planRescan([snap], k2.report, k2.items);
    expect(plan.removed).toEqual({ platform: ["how-to/sso.md"] });
    expect(plan.snapshots).toEqual([]);
    const w = await writeKnowledge(
      root,
      { ...emptyResult(), snapshots: [] },
      "2026-10-23T09:00:00Z",
      { snapshots: [snap], plan },
    );
    expect(w.changes.removed).toEqual(["sso-intake"]);
    expect((await readKnowledge(root)).items.map((i) => i.id)).toEqual(["kafka-topic-request"]);
  });

  it("reads every page again with full", async () => {
    const { root } = await scanned();
    const snap = await sync(root, "2026-10-22T09:00:00Z");
    const k = await readKnowledge(root, { raw: true });
    expect(planRescan([snap], k.report, k.items, { full: true }).snapshots[0]!.pages).toHaveLength(
      2,
    );
  });
});

function emptyResult() {
  return {
    status: "scanned" as const,
    attempts: [],
    items: [],
    conflicts: [],
    superseded: [],
    injections: [],
    failed: [],
    snapshots: [],
  };
}

// A model takes so much at a time (12,078 tokens for Copilot's GPT-4o mini): a source too big
// for one prompt is read in batches, each fitting the budget, and the next scan carries on.
describe("a scan in batches that fit the model", () => {
  it("reads the pages that fit, leaves the rest for the next scan, and keeps what it read", async () => {
    const m = await metarepo();
    const snap = await sync(m.root, "2026-10-20T09:00:00Z");
    const kafka = snap.pages.find((p) => p.pagePath === "how-to/kafka.md")!;
    // A budget for one page only.
    const budget = Math.ceil((kafka.text ?? "").length / 4) + 5;
    const first = planRescan([snap], undefined, [], { batchTokens: budget });
    expect(first.changed).toEqual({ platform: ["how-to/kafka.md"] });
    expect(first.deferred).toEqual({ platform: ["how-to/sso.md"] });
    expect(first.snapshots[0]!.pages.map((p) => p.pagePath)).toEqual(["how-to/kafka.md"]);
    const r1 = await scanKnowledge(first.snapshots, {
      runtime: new MockRuntime(() => answer({ sso: false })),
      now: new Date("2026-10-20T09:00:00Z"),
    });
    await writeKnowledge(m.root, r1, "2026-10-20T09:00:00Z", { snapshots: [snap], plan: first });
    const k1 = await readKnowledge(m.root, { raw: true });
    expect(k1.items.map((i) => i.id)).toEqual(["kafka-topic-request"]);
    // Only the page read is recorded as read.
    expect(Object.keys(k1.report!.snapshots[0]!.hashes!)).toEqual(["how-to/kafka.md"]);

    const second = planRescan([snap], k1.report, k1.items, { batchTokens: budget * 10 });
    expect(second.changed).toEqual({ platform: ["how-to/sso.md"] });
    expect(second.deferred).toEqual({});
    expect(second.previous).toEqual([]);
    const r2 = await scanKnowledge(second.snapshots, {
      runtime: new MockRuntime(() =>
        answer().replace(
          / {2}- kind: request\n {4}id: kafka-topic-request[\s\S]*?\n(?= {2}- kind)/,
          "",
        ),
      ),
      now: new Date("2026-10-20T09:05:00Z"),
    });
    await writeKnowledge(m.root, r2, "2026-10-20T09:05:00Z", { snapshots: [snap], plan: second });
    const k2 = await readKnowledge(m.root, { raw: true });
    // The first batch's item stays; the second's joins it; every page is now recorded.
    expect(k2.items.map((i) => i.id).sort()).toEqual(["kafka-topic-request", "sso-intake"]);
    expect(Object.keys(k2.report!.snapshots[0]!.hashes!).sort()).toEqual([
      "how-to/kafka.md",
      "how-to/sso.md",
    ]);
    expect(planRescan([snap], k2.report, k2.items, { batchTokens: budget }).snapshots).toEqual([]);
  });

  it("reads a page bigger than the budget on its own, rather than never", () => {
    // The scan says the prompt is too long, with the page's name, instead of skipping it.
    return (async () => {
      const m = await metarepo();
      const snap = await sync(m.root, "2026-10-20T09:00:00Z");
      const plan = planRescan([snap], undefined, [], { batchTokens: 1 });
      expect(plan.changed).toEqual({ platform: ["how-to/kafka.md"] });
      expect(plan.deferred).toEqual({ platform: ["how-to/sso.md"] });
    })();
  });
});
