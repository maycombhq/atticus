import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { workItemsCsv } from "@maycombhq/adapters";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  createOpenSpec,
  ORG_FLOW,
  setDefaultSchema,
  writeOrgFlowSchema,
} from "@maycombhq/openspec-adapter";
import {
  architectureStage,
  draftedStories,
  EXPAND_AGENT,
  workItemsOf,
  featureStage,
  readExistingSpecs,
  renderSpecDelta,
  scenarioOf,
  specDeltas,
  storiesStage,
  taskContext,
  validateDraft,
  type StoriesAnswer,
} from "../src/index.js";

/**
 * Atticus 2 as an OpenSpec citizen (ADR 0006 addendum, 2026-10-25), on a metarepo set up with
 * the pinned OpenSpec (1.14.0, local, no network) and the org-flow v2 schema: the stories stage
 * writes the specs as deltas and `openspec validate --strict` passes them; `openspec archive`
 * grows openspec/specs/; a second change on the same flow MODIFIES the archived requirement,
 * keeping its scenarios. Then the ADO export of the same change (B-short). The Forge fraud check
 * (fixtures/stages/stories/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const STORIES_FIX = join(FIX, "stories");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";
const T = 300_000;
const fixture = (f: string) => readFileSync(join(STORIES_FIX, f), "utf8");

async function openspecRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-openspec-specs-"));
  await createOpenSpec({ root }).init();
  await writeOrgFlowSchema(root);
  await setDefaultSchema(root, ORG_FLOW);
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad knowledge record");
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  for (const c of ["add-fraud-check", "bulk-orders"])
    await writeFile(
      join(root, "openspec/changes", c, ".openspec.yaml"),
      `schema: ${ORG_FLOW}\ncreated: 2026-10-21\n`,
    );
  return root;
}

function assistant(draft: string, seen: string[] = []) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT)
        return "terms: [fraud screen, place order]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
      seen.push(req.pack.prompt);
      return draft;
    },
    { now: () => NOW },
  );
}

/** The three stages, each drafting once; their first prompts. */
async function staged(root: string): Promise<string[]> {
  const prompts: string[] = [];
  for (const [stage, answer] of [
    [featureStage, fixture("placed.yaml")],
    [architectureStage, fixture("deltas.yaml")],
    [storiesStage, fixture("answer.yaml")],
  ] as const) {
    const seen: string[] = [];
    expect((await stage(root, CHANGE, { runtime: assistant(answer, seen), now: NOW })).state).toBe(
      "done",
    );
    prompts.push(seen[0]!);
  }
  return prompts;
}

describe("scenarios from criteria", () => {
  it("a Given/When/Then criterion is GIVEN, WHEN and THEN, named by its outcome", () => {
    expect(
      scenarioOf("Given a rejected verdict, when POST /orders is called, then 422 says no."),
    ).toEqual({
      name: "422 says no",
      body: "- **GIVEN** a rejected verdict\n- **WHEN** POST /orders is called\n- **THEN** 422 says no",
    });
    expect(scenarioOf("When the page opens, then the list shows").body).toBe(
      "- **WHEN** the page opens\n- **THEN** the list shows",
    );
    expect(scenarioOf("The total is shown").body).toBe(
      "- **WHEN** the flow runs\n- **THEN** The total is shown",
    );
  });
});

describe("the stories stage as an OpenSpec citizen", () => {
  it(
    "writes deltas openspec validate --strict passes; archive grows the specs; a second change modifies them",
    async () => {
      const root = await openspecRoot();
      // An organisation's rule for its stories, in OpenSpec's own config.
      const cfg = join(root, "openspec/config.yaml");
      await writeFile(
        cfg,
        `${await readFile(cfg, "utf8")}context: |\n  Forge sells parts to workshops.\nrules:\n  stories:\n    - Name the vendor in every story that calls one\n`,
      );
      const [feature, arch, stories] = await staged(root);
      // Each stage's prompt starts from `openspec instructions` for the artifacts it writes.
      expect(feature).toContain("openspec instructions (proposal) --change add-fraud-check");
      expect(arch).toContain("openspec instructions (design) --change add-fraud-check");
      expect(stories).toContain(
        "openspec instructions (stories, specs, tasks) --change add-fraud-check",
      );
      expect(stories).toContain("- Name the vendor in every story that calls one");
      expect(stories).toContain("Forge sells parts to workshops.");
      const os = createOpenSpec({ root });
      const dir = join(root, "openspec/changes", CHANGE);
      // design.md says how each store write is undone (OpenSpec's design artifact asks for it).
      expect(await readFile(join(dir, "design.md"), "utf8")).toContain(
        "| forge-orders-db.orders | adds fraud_verdict (V4__add_fraud_verdict.sql) | Expand-only:",
      );
      // OpenSpec and Atticus agree: every artifact of the change is done after the stories stage.
      const status = await os.status(CHANGE);
      expect(status.artifacts.map((a) => [a.id, a.status])).toEqual([
        ["proposal", "done"],
        ["design", "done"],
        ["stories", "done"],
        ["specs", "done"],
        ["tasks", "done"],
      ]);
      const v = await os.validate({ item: CHANGE, type: "change", strict: true });
      expect(v.items[0]!.issues.filter((i) => i.level !== "INFO")).toEqual([]);
      expect(v.items[0]!.valid).toBe(true);
      const shown = await os.showChange(CHANGE);
      expect(shown.deltas.map((d) => [d.spec, d.operation])).toEqual([
        ["forge-orders-place-order", "ADDED"],
      ]);

      // The task phase reads OpenSpec's count of tasks.md's boxes; a task is named by its number
      // (1.2) or, as before B-short, by its id (1.3).
      const t = await taskContext(root, CHANGE, "1.3");
      expect(t.task.id).toBe("1.2");
      expect(t.notes).toContain(
        "OpenSpec counts 0 of 2 tasks done (atticus openspec instructions apply); tick this one in tasks.md when its tests pass.",
      );
      // Archive (the tasks ticked): openspec/specs/ gains the capability.
      const tasks = join(dir, "tasks.md");
      await writeFile(tasks, (await readFile(tasks, "utf8")).replace(/- \[ \]/g, "- [x]"));
      expect((await os.archive(CHANGE)).specsUpdated).toBe(true);
      const specs = await readExistingSpecs(os);
      expect(specs.map((s) => [s.id, s.flow, s.requirements.length])).toEqual([
        ["forge-orders-place-order", "forge-orders.place-order", 1],
      ]);
      const archived = specs[0]!.requirements[0]!;
      expect(archived.name).toBe("A client places an order");
      expect(archived.scenarios).toHaveLength(7);

      // A second change on the same flow: the capability exists, so its requirement is MODIFIED;
      // a scenario of the same name is replaced, the others are kept, and a new one is added.
      const drafted = await draftedStories(root, CHANGE).catch(() => undefined);
      expect(drafted).toBeUndefined(); // archived: no longer a change in flight
      const second = "hold-big-orders";
      await os.newChange(second);
      const answer = parse(fixture("answer.yaml")) as StoriesAnswer;
      const w = answer.stories[0]!;
      w.title = "Hold big orders for a person";
      w.iWant = "every order above 1000 held for a person before Northwind Pay screens it";
      // the same outcome with another situation: the archived scenario of that name is replaced
      for (const t of w.tasks)
        t.criteria = t.criteria.map((c) =>
          c.text.startsWith("Given a rejected verdict")
            ? { ...c, text: c.text.replace("a rejected verdict", "a rejected or held verdict") }
            : c,
        );
      const t1 = w.tasks[0]!;
      t1.criteria = [
        ...t1.criteria,
        {
          text: "Given an order above 1000, when POST /orders is called, then 202 says the order waits for a person",
          checks: [],
          outcome: "success",
        },
      ];
      const story = {
        id: "s1-place-order",
        repo: "forge-orders",
        flow: "forge-orders.place-order",
        name: "A client places an order",
        change: "modify" as const,
        entry: "POST /orders",
        // a task per task of the answer (the fixture's answer is written per step)
        tasks: w.tasks.map((t, i) => ({
          id: t.id,
          story: "s1-place-order",
          repo: "forge-orders",
          flow: "forge-orders.place-order",
          op: "add" as const,
          position: i + 1,
          title: `Task ${t.id}`,
          what: `Task ${t.id}`,
          fields: [],
          evidence: [],
        })),
      };
      const deltas = specDeltas(second, [story], answer, {
        existing: await readExistingSpecs(os),
        multiRepo: true,
      });
      expect(deltas.map((d) => [d.capability, d.added.length, d.modified.length])).toEqual([
        ["forge-orders-place-order", 0, 1],
      ]);
      const m = deltas[0]!.modified[0]!;
      expect(m.name).toBe("A client places an order");
      expect(m.scenarios.map((s) => s.name)).toEqual([
        ...archived.scenarios.map((s) => s.name),
        "202 says the order waits for a person",
      ]);
      const sd = join(root, "openspec/changes", second);
      await mkdir(join(sd, "specs/forge-orders-place-order"), { recursive: true });
      await writeFile(
        join(sd, "specs/forge-orders-place-order/spec.md"),
        renderSpecDelta(deltas[0]!),
      );
      await writeFile(
        join(sd, "proposal.md"),
        "# Proposal\n\n## Why\n\nOrders above 1000 have shipped to stolen cards before anyone looked at them.\n\n## What Changes\n\n- Hold big orders.\n",
      );
      await writeFile(
        join(sd, "tasks.md"),
        "## forge-orders\n\n- [x] 1.1 Hold (story s1-place-order)\n",
      );
      const v2 = await os.validate({ item: second, type: "change", strict: true });
      expect(v2.items[0]!.issues.filter((i) => i.level !== "INFO")).toEqual([]);
      expect((await os.archive(second)).specsUpdated).toBe(true);
      const after = (await readExistingSpecs(os))[0]!.requirements[0]!;
      expect(after.text).toContain("Hold big orders for a person.");
      expect(after.scenarios).toHaveLength(8);
      expect(
        after.scenarios.find((s) => s.name.startsWith("422 says the verdict refused"))?.rawText,
      ).toContain("a rejected or held verdict");
    },
    T,
  );

  it(
    "a delta openspec refuses is a blocking finding of the stories stage, and nothing is written",
    async () => {
      const root = await openspecRoot();
      const dir = join(root, "openspec/changes", CHANGE);
      const issues = await validateDraft(root, CHANGE, dir, {
        "specs/forge-orders-place-order/spec.md":
          "## ADDED Requirements\n\n### Requirement: A client places an order\nOrders are screened.\n",
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.rule === "openspec.validate" && i.blocking)).toBe(true);
      expect(issues.map((i) => i.message).join("\n")).toMatch(/scenario/i);
      // the draft never touched the change folder
      await expect(
        readFile(join(dir, "specs/forge-orders-place-order/spec.md"), "utf8"),
      ).rejects.toThrow();
    },
    T,
  );

  it(
    "exports the change's stories and tasks as Azure DevOps' import CSV, and Jira's",
    async () => {
      const root = await openspecRoot();
      await staged(root);
      const d = await draftedStories(root, CHANGE);
      const csv = workItemsCsv(workItemsOf(d));
      expect(csv).toBe(fixture("expected/ado.csv"));
      const jira = workItemsCsv(workItemsOf(d), { format: "jira" });
      expect(jira.split("\r\n")[0]).toBe(
        "Issue Id,Issue Type,Summary,Description,Acceptance Criteria,Parent,Labels",
      );
      expect(jira.split("\r\n").filter(Boolean)).toHaveLength(4);
    },
    T,
  );
});
