import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { syncSources, writeSnapshots } from "@maycombhq/knowledge";
import {
  estateOf,
  FlowDelta,
  pageMeta,
  selectTaskKnowledge,
  storyKnowledgeLines,
  taskKnowledgeInput,
  type DeltaStory,
  type Estate,
  type TaskKnowledge,
  type TaskKnowledgeInput,
} from "../src/index.js";

/**
 * Knowledge per task across 12 wikis (ADR 0130), on the invented Forge shop (fixtures/many-wikis):
 * each source's authority and scope, the target state's new component, pages that are no longer
 * current, an approved exception, a stale standard and a mirror. The expected answers are
 * fixtures/many-wikis/expected.yaml, written before the code; this test holds the cases each
 * part of the change is for, and the bench (evals) measures all 14 tasks.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/many-wikis");
const NOW = "2026-10-20T08:00:00Z";

let byTask: Map<string, TaskKnowledge[]>;

/** The fixture's stories and target flows as the stories stage holds them, each task's input. */
function manyWikisInputs(
  change: {
    stories: (Omit<DeltaStory, "tasks"> & { tasks: Record<string, unknown>[] })[];
    targetFlows: Record<string, unknown>[];
  },
  estate: Estate,
): TaskKnowledgeInput[] {
  return change.stories.flatMap((s) =>
    s.tasks.map((t, n) => {
      const task = {
        story: s.id,
        repo: s.repo,
        flow: s.flow,
        position: n + 1,
        fields: [],
        evidence: [],
        ...t,
      } as unknown as DeltaStory["tasks"][number];
      const found = change.targetFlows.find((d) => d.flow === s.flow);
      const delta = found ? FlowDelta.parse(found) : undefined;
      return taskKnowledgeInput({ ...s, tasks: [] } as DeltaStory, task, delta, estate);
    }),
  );
}

async function writeRecords(root: string, dir: string, file: string): Promise<CatalogRecord[]> {
  const out: CatalogRecord[] = [];
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
    out.push(p.record);
  }
  return out;
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-many-wikis-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  await cp(join(FIX, "sources"), join(root, "wikis"), { recursive: true });
  const records = await writeRecords(root, "catalog/generated", join(FIX, "catalog.yaml"));
  const op = await loadOrgPack(join(root, "org-pack"));
  if (op.problems.length) throw new Error(JSON.stringify(op.problems));
  const s = await syncSources({ root, orgPack: op, now: NOW });
  await writeSnapshots({ root, orgPack: op, sync: s, takenAt: NOW });
  await writeRecords(root, "knowledge/items", join(FIX, "knowledge.yaml"));
  await cp(join(FIX, "scan.yaml"), join(root, "knowledge/scan.yaml"));
  const change = parse(readFileSync(join(FIX, "change.yaml"), "utf8"));
  const inputs = manyWikisInputs(change, estateOf(records, []));
  expect(inputs).toHaveLength(14);
  byTask = (await selectTaskKnowledge(root, change.change, inputs, { now: NOW })).byTask;
}, 120_000);

const ids = (task: string) => (byTask.get(task) ?? []).map((k) => k.id);
const entry = (task: string, id: string) => byTask.get(task)?.find((k) => k.id === id);
const pages = (task: string) =>
  (byTask.get(task) ?? []).flatMap((k) => [k.page, ...k.alsoOn].filter((p) => !!p));

describe("scope: a source's pages attach only where it applies", () => {
  it("gives a task on OpenShift the OpenShift timeouts, never the Cloud Run ones", () => {
    expect(ids("1.5")).toContain("openshift-route-timeouts");
    expect(ids("1.5")).not.toContain("cloud-run-timeouts");
    const k = entry("1.5", "openshift-route-timeouts")!;
    expect(k.page).toMatchObject({ source: "openshift-platform", authority: "platform" });
    expect(k.page!.scope).toBe("platforms openshift: forge-orders runs on openshift");
    expect(k.why).toMatch(/openshift-platform applies to platforms openshift/);
  });

  it("gives the GCP platform's new-service how-to to a task that creates a new component", () => {
    expect(ids("3.1")).toContain("cloud-run-new-service");
    const k = entry("3.1", "cloud-run-new-service")!;
    expect(k.page!.scope).toMatch(/new components: this task creates forge-refund-worker/);
    // ...and never to a task that creates none and doesn't run on GCP.
    for (const t of ["1.1", "1.5", "5.1"]) expect(ids(t)).not.toContain("cloud-run-new-service");
  });

  it("keeps a framework's pages to the repos built on it", () => {
    expect(ids("1.1")).toContain("anvil-rest-endpoint");
    expect(ids("5.1")).not.toContain("anvil-rest-endpoint");
    expect(ids("5.2")).toContain("angular-form-validation");
  });
});

describe("authority decides only between pages on the same topic", () => {
  it("leads with the current page: a deprecated page ranks below it, however recent", () => {
    const k = entry("1.3", "order-events-v2")!;
    expect(k.page).toMatchObject({ source: "orders-team", page: "events/order-events-v2.md" });
    expect(k.sameAs).toContain("order-events-v1");
    expect(k.alsoOn.find((p) => p.page === "events/order-events-v1.md")).toMatchObject({
      status: "deprecated",
    });
    expect(ids("1.3")).not.toContain("order-events-v1");
  });

  it("puts the precise how-to before a loosely related standard", () => {
    const list = ids("1.3");
    if (list.includes("event-principles"))
      expect(list.indexOf("order-events-v2")).toBeLessThan(list.indexOf("event-principles"));
  });

  it("leads a drifted copy's topic with the standard it was copied from", () => {
    const k = entry("1.1", "error-response-format")!;
    expect(k.page).toMatchObject({ source: "ea-standards", authority: "standard" });
    for (const t of byTask.get("1.1")!) expect(t.page?.page).not.toBe("api/api-errors.md");
  });

  it("shows a stale standard as may be out of date, and the team page that disagrees", () => {
    const k = entry("1.4", "idempotency-keys")!;
    expect(k.page).toMatchObject({
      source: "ea-standards",
      page: "Standards/Idempotency-Keys.md",
      outOfDate: { since: "2023-01-10", months: 18 },
    });
    expect(pageMeta(k.page!)).toMatch(/may be out of date \(not updated since 2023-01-10\)/);
    const c = k.conflicts[0]!;
    expect(c.suggested).toMatch(/^ea-standards\/Standards\/Idempotency-Keys\.md, by authority/);
    expect(c.state).toBe("not-asked");
  });
});

describe("an approved exception", () => {
  it("is suggested within its scope, and the standard outside it", () => {
    const stock = entry("4.1", "internal-tls")!;
    expect(stock.conflicts[0]!.suggested).toMatch(
      /^stock-team\/warehouse\/legacy-warehouse-link\.md, by exception: .*WVR-2291/,
    );
    // A forge-orders task (its call's timeout) is outside the exception's scope.
    const orders = entry("1.5", "internal-tls")!;
    expect(orders.conflicts[0]!.suggested).toMatch(
      /^security-standards\/tls\/internal-calls-tls\.md, by authority/,
    );
    expect(ids("1.4")).not.toContain("warehouse-link-tls-exception");
    expect(ids("4.1")).toContain("warehouse-link-tls-exception");
  });
});

describe("a page mirrored in two wikis, and a restricted page", () => {
  it("is read once, from the more authoritative wiki; a restricted page never attaches", () => {
    expect(entry("4.2", "structured-logging")?.page?.source).toBe("ea-standards");
    for (const t of byTask.keys()) {
      for (const p of pages(t)) {
        expect(`${p.source}/${p.page}`).not.toBe("web-team/copied/logging-standard.md");
        expect(p.page).not.toMatch(/pen-test|Fraud-thresholds/);
      }
    }
  });

  it("writes each attached page's authority and why it applied in the story file", () => {
    const lines = storyKnowledgeLines(byTask.get("1.5")!).join("\n");
    expect(lines).toMatch(/openshift-platform\/routes\/timeouts\.md#timeouts.*\(.*platform/);
    expect(lines).toMatch(/applies to platforms openshift/);
  });
});
