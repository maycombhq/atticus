import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  checkDeltas,
  checkStories,
  consumerIssues,
  FlowDelta,
  issueFingerprint,
  knownToChange,
  loadEstate,
  placeIssues,
  shapeTarget,
  StoriesAnswerSchema,
  unreadConsumer,
  type DeltaStory,
  type Estate,
} from "../src/index.js";

/**
 * ADR 0203 A, the review's blocker: an acceptance covers exactly what was accepted. Each rule a
 * person may accept keeps the accepted value in its finding's target, so its fingerprint changes
 * with the value: a draft that names another component, entry, folder, consumer, field or story
 * is a new open finding, and the same value is still the accepted one. Invented Forge names.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const HOLD = join(FIX, "stages/hold-stock");
const LEVELS = ["public", "internal", "confidential", "restricted"];

async function holdEstate(): Promise<Estate> {
  const root = await mkdtemp(join(tmpdir(), "atticus-accept-values-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/pin-table/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(HOLD, "catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  return loadEstate(root, (await loadChangeContext(root)).records);
}

const placement = { summary: "s", features: [], flows: [], newFlows: [] } as never;
const step = (s: Record<string, unknown>) =>
  FlowDelta.parse({
    schemaVersion: 2,
    flow: "forge-orders.place-order",
    repo: "forge-orders",
    change: "modify",
    why: "w",
    steps: [{ op: "add", after: 1, kind: "call-out", what: "Ask.", ...s }],
  });
const targets = (issues: { rule: string; target: string }[], rule: string) =>
  issues.filter((i) => i.rule === rule).map((i) => i.target);

describe("the accepted value is in the target", () => {
  it("delta.unknown-component: the component", async () => {
    const e = await holdEstate();
    const a = checkDeltas(
      [step({ to: { component: "forge-ghost-svc", entry: "POST /x" } })],
      e,
      placement,
      [],
      { levels: LEVELS },
    );
    const b = checkDeltas(
      [step({ to: { component: "forge-evil-svc", entry: "POST /x" } })],
      e,
      placement,
      [],
      { levels: LEVELS },
    );
    expect(targets(a, "delta.unknown-component")).toEqual([
      "forge-orders.place-order#1:forge-ghost-svc",
    ]);
    expect(targets(b, "delta.unknown-component")).toEqual([
      "forge-orders.place-order#1:forge-evil-svc",
    ]);
  });

  it("delta.unknown-entry: the component and the entry", async () => {
    const e = await holdEstate();
    const got = checkDeltas(
      [step({ to: { component: "forge-stock", entry: "POST /nope" } })],
      e,
      placement,
      [],
      { levels: LEVELS },
    );
    expect(targets(got, "delta.unknown-entry")).toEqual([
      "forge-orders.place-order#1:forge-stock:POST /nope",
    ]);
  });

  it("delta.new-folder: the folder, or the path that isn't one", async () => {
    const e = await holdEstate();
    const got = await placeIssues([step({ new: "src/main/java/forge/nowhere/Screen.java" })], e);
    expect(targets(got, "delta.new-folder")).toEqual([
      "forge-orders.place-order#1:new:src/main/java/forge/nowhere",
    ]);
  });

  it("delta.consumer-missing: the consumers left out, sorted", async () => {
    const e = await holdEstate();
    const marked = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "Every order says which shop it is for.",
      steps: [
        {
          op: "change",
          step: 1,
          kind: "entry",
          fields: { reads: ["sku", "quantity", "shopId"] },
          breaking: true,
          why: "shopId is required.",
        },
      ],
    });
    expect(targets(consumerIssues([marked], e), "delta.consumer-missing")).toEqual([
      "forge-orders.place-order:forge-web",
    ]);
  });

  it("stories.field-not-checked: the task and its fields; stories.shape-uncovered: the story", () => {
    const ONCE = join(FIX, "stages/stories-once");
    const stories = parse(readFileSync(join(ONCE, "stories.yaml"), "utf8")) as DeltaStory[];
    const a = StoriesAnswerSchema.parse(parse(readFileSync(join(ONCE, "answer.yaml"), "utf8")));
    for (const t of a.stories[0]!.tasks) for (const c of t.criteria) c.checks = [];
    const got = checkStories(a, stories, [], [], { sections: true, known: new Set() });
    expect(targets(got, "stories.field-not-checked")).toContain("1.3:deliver_by");
    expect(shapeTarget('Story s2-refund "Refund" has no task yet: put under it…')).toBe(
      "stage/stories-shape.yaml:s2-refund",
    );
    expect(shapeTarget('Story s3-cancel "Cancel" has no task yet')).not.toBe(
      shapeTarget('Story s2-refund "Refund" has no task yet'),
    );
  });
});

describe("an id accepted under one rule is not known under another", () => {
  it("a component accepted as a call's target is no consumer; a consumer accepted as one is", () => {
    const e = {
      ids: new Set<string>(),
      flows: [],
      records: [],
      manifestRepos: new Set<string>(),
      accepted: new Map([
        ["forge-ghost-svc", { by: "pat", why: "New.", rule: "delta.unknown-component" }],
        ["forge-ghost-app", { by: "pat", why: "New.", rule: "delta.unknown-consumer" }],
        ["forge-ghost-repo", { by: "pat", why: "New.", rule: "feature.unknown-repo" }],
      ]),
    };
    expect([...knownToChange([], e).keys()]).toEqual(["forge-ghost-app"]);
    expect(unreadConsumer("forge-ghost-svc", [], e)).toBeUndefined();
    expect(unreadConsumer("forge-ghost-repo", [], e)).toBeUndefined();
    expect(unreadConsumer("forge-ghost-app", [], e)).toBe(
      "is accepted by pat: New, so its use can't be checked.",
    );
    expect(issueFingerprint("delta.unknown-component", "f#1:forge-ghost-svc")).not.toBe(
      issueFingerprint("delta.unknown-component", "f#1:forge-evil-svc"),
    );
  });
});
