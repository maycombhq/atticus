import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  type FlowRecord,
} from "@maycombhq/core";
import { createOpenSpec } from "@maycombhq/openspec-adapter";
import { editedByPerson } from "@maycombhq/naysayer";
import {
  architectureStage,
  deployIssues,
  draftProvenance,
  estateOf,
  EXPAND_AGENT,
  featureStage,
  FlowDelta,
  ownSections,
  PROPOSAL_MARK,
  renderSpecDelta,
  specDeltas,
  storiesFromDeltas,
  storiesStage,
  StoriesAnswerSchema,
  type DeltaStory,
} from "../src/index.js";

/**
 * Review round 50 (planner): proposal.md has one owner per section; a tick in tasks.md isn't an
 * edit of the draft; a step's words on two lines stay on one checkbox line; two repos' migrations
 * of one name are two; two requirements of one name in a merged spec delta are told apart.
 * Invented: the Forge fraud check (fixtures/stages/stories/) and order summary (stories-units/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const STORIES = join(FIX, "stages/stories");
const NOW = new Date("2026-11-09T09:00:00Z");
const CHANGE = "add-fraud-check";
const fixture = (f: string) => readFileSync(join(STORIES, f), "utf8");

const recs = (rows: unknown[]): CatalogRecord[] =>
  rows.map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });

async function fraudRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-round-50-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = recs([
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ]);
  for (const r of rows) {
    const f = join(root, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  for (const r of recs(
    parse(readFileSync(join(FIX, "stages/knowledge.yaml"), "utf8")) as unknown[],
  )) {
    const f = join(root, "knowledge/items", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

function assistant(drafts: string[]) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT)
        return "terms: [fraud screen, place order]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

const PROPOSAL = [
  PROPOSAL_MARK,
  "# Proposal: Screen orders",
  "",
  "## Why",
  "",
  "Orders are screened.",
  "",
  "## Capabilities",
  "",
  "PLACEHOLDER",
  "",
  "## Impact",
  "",
  "- Repos: forge-orders.",
  "",
].join("\n");

describe("proposal.md: the feature stage's sections and the stories stage's Capabilities", () => {
  it("each stage writes its own sections and keeps the other's", () => {
    const stories = PROPOSAL.replace("PLACEHOLDER", "### Modified Capabilities\n- `place-order`");
    // the stories stage writes Capabilities only, over a Why a person may have changed
    const edited = PROPOSAL.replace("Orders are screened.", "Orders are screened first.");
    expect(ownSections(edited, stories, "stories")).toBe(
      stories.replace("Orders are screened.", "Orders are screened first."),
    );
    // the feature stage writes the rest and keeps the stories stage's Capabilities
    const feature = PROPOSAL.replace(
      "- Repos: forge-orders.",
      "- Repos: forge-orders, forge-stock.",
    );
    expect(ownSections(stories, feature, "feature")).toBe(
      stories.replace("- Repos: forge-orders.", "- Repos: forge-orders, forge-stock."),
    );
  });

  it("after the stories stage, proposal.md is no person's edit, and the feature stage keeps its Capabilities", async () => {
    const root = await fraudRoot();
    const dir = join(root, "openspec/changes", CHANGE);
    const run = { now: NOW };
    expect(
      (await featureStage(root, CHANGE, { runtime: assistant([fixture("placed.yaml")]), ...run }))
        .state,
    ).toBe("done");
    expect(
      (
        await architectureStage(root, CHANGE, {
          runtime: assistant([fixture("deltas.yaml")]),
          ...run,
        })
      ).state,
    ).toBe("done");
    expect(
      (await storiesStage(root, CHANGE, { runtime: assistant([fixture("answer.yaml")]), ...run }))
        .state,
    ).toBe("done");
    const proposal = await readFile(join(dir, "proposal.md"), "utf8");
    expect(proposal).toContain("### New Capabilities");
    // the critic's edit-and-apply: no file is a person's edit
    expect(await editedByPerson(dir)).toEqual([]);
    // the feature stage again: proposal.md isn't a person's draft, and its Capabilities stay
    const again = await featureStage(root, CHANGE, {
      runtime: assistant([fixture("placed.yaml")]),
      ...run,
      force: true,
    });
    expect(again.notes.join("\n")).not.toMatch(/person edited/i);
    expect(await readFile(join(dir, "proposal.md"), "utf8")).toContain("### New Capabilities");
    expect(await editedByPerson(dir)).toEqual([]);
  });

  it("a tick in tasks.md is progress, not a person's edit of the draft", async () => {
    const root = await fraudRoot();
    const dir = join(root, "openspec/changes", CHANGE);
    await featureStage(root, CHANGE, { runtime: assistant([fixture("placed.yaml")]), now: NOW });
    await architectureStage(root, CHANGE, {
      runtime: assistant([fixture("deltas.yaml")]),
      now: NOW,
    });
    await storiesStage(root, CHANGE, { runtime: assistant([fixture("answer.yaml")]), now: NOW });
    const tasks = await readFile(join(dir, "tasks.md"), "utf8");
    expect(tasks).toContain("- [ ] 1.1 ");
    await writeFile(join(dir, "tasks.md"), tasks.replace("- [ ] 1.1 ", "- [x] 1.1 "));
    expect(await editedByPerson(dir)).toEqual([]);
    expect((await draftProvenance(dir, CHANGE, ["tasks.md"]))["tasks.md"]).toMatchObject({
      by: "ai",
      stage: "stories",
    });
    // the stories stage again keeps the tick and doesn't take tasks.md for a person's draft
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant([fixture("answer.yaml")]),
      now: NOW,
      force: true,
    });
    expect(r.notes.join("\n")).not.toMatch(/person edited/i);
    expect(await readFile(join(dir, "tasks.md"), "utf8")).toContain("- [x] 1.1 ");
    // a real edit still is one
    await writeFile(join(dir, "tasks.md"), tasks.replace("- [ ] 1.1 ", "- [ ] 1.1 Rewritten: "));
    expect(await editedByPerson(dir)).toEqual(["tasks.md"]);
  });
});

// ---------------------------------------------------------------- stories without a file

const units = () => {
  const read = (f: string) => readFileSync(join(FIX, "stages/stories-units", f), "utf8");
  const e = estateOf(
    recs(parse(read("catalog.yaml")) as unknown[]),
    recs(parse(read("flows.yaml")) as unknown[]).map((flow) => ({
      repo: (flow as FlowRecord).component,
      flow: flow as FlowRecord,
    })),
  );
  const deltas = (parse(read("deltas.yaml")) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );
  return { e, deltas };
};

describe("a step's words on two lines", () => {
  it("make a task title on one line, so tasks.md's checkbox line keeps its story", () => {
    const { e, deltas } = units();
    const web = deltas.find((d) => d.repo === "forge-web")!;
    web.steps[0]!.what = "The page gets the summary\r\nand shows a spinner   while it waits";
    const [s] = storiesFromDeltas([web], e) as [DeltaStory];
    expect(s.tasks.map((t) => t.title)).toEqual([
      "Add the call-out step: The page gets the summary and shows a spinner while it waits, and 1 more step in orders.ts",
      "Change the respond step: The page shows the order's status and its summary, each sentence linking its event",
    ]);
    expect(s.tasks[0]!.covers![0]!.what).toBe(
      "The page gets the summary and shows a spinner while it waits",
    );
  });
});

describe("two repos' migrations of one name", () => {
  const flow = (repo: string, table: string) =>
    FlowDelta.parse({
      schemaVersion: 2,
      flow: `${repo}.keep-notes`,
      repo,
      change: "new",
      name: "Notes are kept",
      trigger: { kind: "job", what: "Nightly" },
      why: "Notes are kept.",
      steps: [
        {
          op: "add",
          kind: "write",
          what: "A note is written",
          store: { table, columns: ["id"], new: true, migration: "V2__init.sql" },
        },
      ],
    });
  it("are two migrations: leaving one out of the deploy order is said, with its repo", () => {
    const deltas = [
      flow("forge-notes", "forge-notes-db.notes"),
      flow("forge-tags", "forge-tags-db.tags"),
    ];
    const e = estateOf([], []);
    const issues = deployIssues(
      deltas,
      [
        { repo: "forge-notes", migration: "V2__init.sql" },
        { repo: "forge-notes" },
        { repo: "forge-tags" },
      ],
      e,
    ).filter((i) => i.blocking);
    expect(issues.map((i) => [i.rule, i.target])).toEqual([
      ["delta.deploy-missing", "deploy:forge-tags:V2__init.sql"],
    ]);
    expect(issues[0]!.message).toBe(
      "The deploy order doesn't run migration V2__init.sql (in forge-tags), which changes forge-tags-db.tags: add a step for forge-tags with migration: V2__init.sql, before the code that needs it.",
    );
    // both run, each before its repo's code: nothing to say
    expect(
      deployIssues(
        deltas,
        [
          { repo: "forge-notes", migration: "V2__init.sql" },
          { repo: "forge-tags", migration: "V2__init.sql" },
          { repo: "forge-notes" },
          { repo: "forge-tags" },
        ],
        e,
      ).filter((i) => i.blocking),
    ).toEqual([]);
  });
});

describe("two flows' requirements in one capability", () => {
  it("are named apart, so openspec validate --strict passes the merged delta", async () => {
    const story = (repo: string): DeltaStory => ({
      id: repo === "forge-orders" ? "s1-place-order" : "s2-place-order",
      repo,
      flow: `${repo}.place-order`,
      name: "Place order",
      change: "new",
      tasks: [
        {
          id: repo === "forge-orders" ? "1.1" : "2.1",
          story: "",
          repo,
          flow: `${repo}.place-order`,
          op: "add",
          position: 1,
          title: "Add the step",
          what: "x",
          fields: [],
          evidence: [],
        },
      ],
    });
    const stories = [story("forge-orders"), story("forge-web")];
    const answer = StoriesAnswerSchema.parse({
      stories: stories.map((s) => ({
        id: s.id,
        title: "Place order",
        asA: "user",
        iWant: "x",
        soThat: "y",
        tasks: [{ id: s.tasks[0]!.id, criteria: [{ text: "When placed, then ok", checks: [] }] }],
      })),
    });
    const deltas = specDeltas("c1", stories, answer, { multiRepo: false });
    expect(deltas.map((d) => d.added.map((r) => r.name))).toEqual([
      ["Place order", "Place order (forge-web.place-order)"],
    ]);
    // the pinned OpenSpec, local: the merged delta validates
    const root = await mkdtemp(join(tmpdir(), "atticus-round-50-os-"));
    const c = join(root, "openspec/changes/c1");
    await mkdir(join(c, "specs/place-order"), { recursive: true });
    await mkdir(join(root, "openspec/specs"), { recursive: true });
    await writeFile(
      join(c, "proposal.md"),
      "## Why\nBecause the order must be screened before stock is reserved for it.\n\n## What Changes\n- Adds screening.\n",
    );
    await writeFile(join(c, "specs/place-order/spec.md"), renderSpecDelta(deltas[0]!));
    const r = await createOpenSpec({ root }).validate({ item: "c1", type: "change", strict: true });
    expect((r.items[0]?.issues ?? []).filter((i) => i.level === "ERROR")).toEqual([]);
  }, 120_000);
});
