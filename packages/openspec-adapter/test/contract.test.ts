/**
 * Contract tests: run the real, pinned OpenSpec CLI and check every behaviour and JSON field
 * Atticus relies on. When OpenSpec is upgraded, these tests decide whether the new version
 * is accepted. They run offline (telemetry and update checks are off).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ARTIFACT_STAGE,
  createOpenSpec,
  OPENSPEC_PINNED,
  ORG_FLOW,
  ORG_FLOW_ARTIFACTS,
  ORG_FLOW_VERSION,
  orgFlowSchema,
  orgFlowVersionOf,
  setDefaultSchema,
  writeOrgFlowSchema,
  type OpenSpec,
} from "../src/index.js";

const T = 60_000;

const PROPOSAL = `# Proposal

## Why

Customers can move unlimited amounts in a day.

## What Changes

- Add a daily transfer limit.

## Capabilities

### New Capabilities
- \`transfers\`: moving money between accounts

## Impact

Ledger API.
`;

const SPEC = `## ADDED Requirements

### Requirement: Daily transfer limit
The system SHALL reject a transfer that takes the day's total above the account's daily limit.

#### Scenario: Over the limit
- **WHEN** a transfer would take the day's total above the limit
- **THEN** the transfer is rejected with reason LIMIT_EXCEEDED
`;

async function freshRoot(): Promise<{ root: string; os: OpenSpec }> {
  const root = await mkdtemp(join(tmpdir(), "atticus-openspec-"));
  const os = createOpenSpec({ root, timeoutMs: T });
  await os.init();
  return { root, os };
}

async function writeChange(root: string, id: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, "openspec", "changes", id, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, text, "utf8");
  }
}

describe("OpenSpec stable core contract", () => {
  let root: string;
  let os: OpenSpec;

  beforeAll(async () => {
    ({ root, os } = await freshRoot());
  }, T);

  it(
    "is the pinned version and supported",
    async () => {
      // The weekly compatibility job runs this suite against a newer OpenSpec (ATTICUS_OPENSPEC_BIN).
      const pinned = process.env.ATTICUS_OPENSPEC_BIN ? await os.version() : OPENSPEC_PINNED;
      expect(await os.version()).toBe(pinned);
      expect(await os.assertSupported()).toBe(pinned);
    },
    T,
  );

  it("init creates the folder layout and no assistant files", async () => {
    for (const p of ["openspec/config.yaml", "openspec/specs", "openspec/changes/archive"]) {
      expect(existsSync(join(root, p)), p).toBe(true);
    }
    for (const p of [".claude", ".github", "AGENTS.md", ".cursor"])
      expect(existsSync(join(root, p)), p).toBe(false);
    expect(parse(await readFile(join(root, "openspec/config.yaml"), "utf8")).schema).toBe(
      "spec-driven",
    );
  });

  it(
    "lists nothing in a new root",
    async () => {
      expect(await os.listChanges()).toEqual([]);
      expect(await os.listSpecs()).toEqual([]);
    },
    T,
  );

  it(
    "creates a change and reports artifact status in dependency order",
    async () => {
      const c = await os.newChange("add-transfer-limit", {
        description: "Add a daily transfer limit",
      });
      expect(c).toMatchObject({ id: "add-transfer-limit", schema: "spec-driven" });
      expect(existsSync(join(root, "openspec/changes/add-transfer-limit/.openspec.yaml"))).toBe(
        true,
      );

      const s = await os.status("add-transfer-limit");
      expect(s.isComplete).toBe(false);
      expect(s.applyRequires).toEqual(["tasks"]);
      expect(s.artifacts.map((a) => [a.id, a.status])).toEqual([
        ["proposal", "ready"],
        ["specs", "blocked"],
        ["design", "blocked"],
        ["tasks", "blocked"],
      ]);
      expect(s.artifacts.find((a) => a.id === "tasks")!.missingDeps).toEqual(["specs", "design"]);
    },
    T,
  );

  it(
    "gives instructions and a template for an artifact",
    async () => {
      const i = await os.instructions("proposal", "add-transfer-limit");
      expect(i.outputPath).toBe("proposal.md");
      expect(i.template).toContain("## Why");
      expect(i.unlocks).toEqual(["specs", "design"]);
    },
    T,
  );

  it(
    "rejects a change with no deltas, as a report not an exception",
    async () => {
      await writeChange(root, "add-transfer-limit", { "proposal.md": PROPOSAL });
      const r = await os.validate({ item: "add-transfer-limit", type: "change" });
      expect(r.items[0]).toMatchObject({ id: "add-transfer-limit", type: "change", valid: false });
      expect(r.items[0]!.issues.some((x) => x.level === "ERROR" && /delta/i.test(x.message))).toBe(
        true,
      );
      expect(r.summary.totals.failed).toBe(1);
    },
    T,
  );

  it(
    "accepts a complete change, ignoring Atticus's own files in the folder",
    async () => {
      await writeChange(root, "add-transfer-limit", {
        "specs/transfers/spec.md": SPEC,
        "design.md": "# Design\n\nCheck the running total in ledger-api.\n",
        "tasks.md": "## 1. Limit\n\n- [x] 1.1 Add the limit check\n- [ ] 1.2 Add tests\n",
        "brief.md": "# Brief\n\nLimit daily transfers.\n",
        "repos.yaml": "schemaVersion: 1\nchange: add-transfer-limit\nrepos: []\n",
        "ux.md": "# UX\n",
        "stories/s1.md": "# s1\n",
        "review/conditions.yaml": "conditions: []\n",
      });
      const r = await os.validate({ item: "add-transfer-limit", type: "change", strict: true });
      expect(r.items[0]!.valid).toBe(true);

      const s = await os.status("add-transfer-limit");
      expect(s.artifacts.every((a) => a.status === "done")).toBe(true);
    },
    T,
  );

  it(
    "shows parsed deltas and task progress",
    async () => {
      const d = await os.showChange("add-transfer-limit");
      expect(d.deltaCount).toBe(1);
      expect(d.deltas[0]).toMatchObject({ spec: "transfers", operation: "ADDED" });
      expect(d.deltas[0]!.requirements![0]!.name).toBe("Daily transfer limit");
      expect(d.deltas[0]!.requirements![0]!.scenarios[0]!.rawText).toContain("LIMIT_EXCEEDED");

      const [c] = await os.listChanges();
      expect(c).toMatchObject({ name: "add-transfer-limit", completedTasks: 1, totalTasks: 2 });

      const a = await os.applyInstructions("add-transfer-limit");
      expect(a.progress).toMatchObject({ total: 2, complete: 1, remaining: 1 });
      expect(a.tasks.map((t) => t.done)).toEqual([true, false]);
    },
    T,
  );

  it(
    "Atticus refuses to archive with unfinished tasks (OpenSpec alone would not)",
    async () => {
      await expect(os.archive("add-transfer-limit")).rejects.toMatchObject({
        code: "tasks_incomplete",
      });
      expect(existsSync(join(root, "openspec/changes/add-transfer-limit"))).toBe(true);
    },
    T,
  );

  it(
    "archives a finished change and merges its deltas into the specs",
    async () => {
      await writeChange(root, "add-transfer-limit", {
        "tasks.md": "## 1. Limit\n\n- [x] 1.1 Add the limit check\n- [x] 1.2 Add tests\n",
      });
      const a = await os.archive("add-transfer-limit");
      expect(a.change).toBe("add-transfer-limit");
      expect(a.archivedAs).toMatch(/^\d{4}-\d{2}-\d{2}-add-transfer-limit$/);
      expect(a.specsUpdated).toBe(true);
      expect(existsSync(join(root, "openspec/changes/archive", a.archivedAs, "repos.yaml"))).toBe(
        true,
      );

      const specs = await os.listSpecs();
      expect(specs).toEqual([expect.objectContaining({ id: "transfers", requirementCount: 1 })]);
      const spec = await os.showSpec("transfers");
      expect(spec.requirements[0]!.text).toContain("SHALL reject");
    },
    T,
  );

  it(
    "raises OpenSpec's error code for an unknown change",
    async () => {
      await expect(os.status("does-not-exist")).rejects.toMatchObject({ code: "change_error" });
    },
    T,
  );

  it(
    "accepts skip_specs for a change with no behaviour change",
    async () => {
      await os.newChange("tidy-logging");
      const meta = join(root, "openspec/changes/tidy-logging/.openspec.yaml");
      await writeFile(meta, (await readFile(meta, "utf8")) + "skip_specs: true\n", "utf8");
      await writeChange(root, "tidy-logging", {
        "proposal.md": "# Proposal\n\n## Why\n\nNoise.\n",
      });
      const r = await os.validate({ item: "tidy-logging" });
      expect(r.items[0]!.valid).toBe(true);
    },
    T,
  );
});

describe("org-flow schema", () => {
  let root: string;
  let os: OpenSpec;

  beforeAll(async () => {
    ({ root, os } = await freshRoot());
    await writeOrgFlowSchema(root);
    await setDefaultSchema(root, ORG_FLOW);
  }, T);

  it(
    "is listed by OpenSpec as a project schema with all artifacts",
    async () => {
      const s = (await os.schemas()).find((x) => x.name === ORG_FLOW);
      expect(s).toBeDefined();
      expect(s!.source).toBe("project");
      expect(s!.artifacts).toEqual(ORG_FLOW_ARTIFACTS);
    },
    T,
  );

  it("keeps config.yaml comments when the default schema is set", async () => {
    const text = await readFile(join(root, "openspec/config.yaml"), "utf8");
    expect(parse(text).schema).toBe(ORG_FLOW);
    expect(text).toContain("# Per-artifact rules");
  });

  it(
    "drives a new change in the canonical order",
    async () => {
      const c = await os.newChange("add-transfer-limit");
      expect(c.schema).toBe(ORG_FLOW);
      const s = await os.status("add-transfer-limit");
      const ready = s.artifacts.filter((a) => a.status === "ready").map((a) => a.id);
      expect(ready).toEqual(["proposal"]);
      // Version 2: Atticus 2's stages, in their order (feature → architecture → stories).
      const req = Object.fromEntries(s.artifacts.map((a) => [a.id, a.requires]));
      expect(req).toEqual({
        proposal: [],
        design: ["proposal"],
        stories: ["design"],
        specs: ["stories"],
        tasks: ["stories"],
      });
      expect(Object.keys(req)).toEqual(["proposal", "design", "stories", "specs", "tasks"]);
      expect(ARTIFACT_STAGE).toEqual({
        proposal: "feature",
        design: "architecture",
        stories: "stories",
        specs: "stories",
        tasks: "stories",
      });
    },
    T,
  );

  it(
    "unlocks the design once the proposal exists, and the stories after it",
    async () => {
      await writeChange(root, "add-transfer-limit", { "proposal.md": PROPOSAL });
      let s = await os.status("add-transfer-limit");
      expect(s.artifacts.filter((a) => a.status === "ready").map((a) => a.id)).toEqual(["design"]);
      await writeChange(root, "add-transfer-limit", { "design.md": "# Design\n" });
      s = await os.status("add-transfer-limit");
      expect(s.artifacts.filter((a) => a.status === "ready").map((a) => a.id)).toEqual(["stories"]);
    },
    T,
  );

  it(
    "serves Atticus's instructions and templates, with the config's context and rules",
    async () => {
      const cfg = join(root, "openspec/config.yaml");
      await writeFile(
        cfg,
        (await readFile(cfg, "utf8")) +
          "context: |\n  Forge sells parts.\nrules:\n  stories:\n    - Keep each story under 150 lines\n",
        "utf8",
      );
      const i = await os.instructions("design", "add-transfer-limit");
      expect(i.outputPath).toBe("design.md");
      expect(i.instruction).toContain("Rollout\nand rollback");
      expect(i.template).toContain("## Rollout and rollback");
      const st = await os.instructions("stories", "add-transfer-limit");
      expect(st.context).toContain("Forge sells parts.");
      expect(st.rules).toEqual(["Keep each story under 150 lines"]);
    },
    T,
  );

  it(
    "validates and archives an Atticus 2 change: the specs grow, a second change modifies them",
    async () => {
      await writeChange(root, "add-transfer-limit", {
        "stories.md": "# Stories\n",
        "specs/transfers/spec.md": SPEC,
        "tasks.md": "# Tasks\n\n## ledger-api\n\n- [x] 1.1 Add the limit (story s1)\n",
      });
      const s = await os.status("add-transfer-limit");
      expect(s.isComplete).toBe(true);
      expect(
        (await os.validate({ item: "add-transfer-limit", strict: true })).items[0]!.valid,
      ).toBe(true);
      await os.archive("add-transfer-limit");
      expect((await os.listSpecs()).map((x) => [x.id, x.requirementCount])).toEqual([
        ["transfers", 1],
      ]);
      await os.newChange("raise-transfer-limit");
      await writeChange(root, "raise-transfer-limit", {
        "proposal.md": PROPOSAL,
        "specs/transfers/spec.md": SPEC.replace("ADDED", "MODIFIED").replace(
          "rejected with reason LIMIT_EXCEEDED\n",
          "rejected with reason LIMIT_EXCEEDED\n\n#### Scenario: Premium limit\n- **WHEN** a premium account moves 20000\n- **THEN** the transfer is accepted\n",
        ),
        "tasks.md": "## ledger-api\n\n- [x] 1.1 Raise the limit (story s1)\n",
      });
      expect(
        (await os.validate({ item: "raise-transfer-limit", strict: true })).items[0]!.valid,
      ).toBe(true);
      expect((await os.archive("raise-transfer-limit")).specsUpdated).toBe(true);
      const spec = await os.showSpec("transfers");
      expect(spec.requirements[0]!.scenarios.map((x) => x.name)).toEqual([
        "Over the limit",
        "Premium limit",
      ]);
    },
    T,
  );

  it("knows the version a metarepo installed", async () => {
    expect(await orgFlowVersionOf(root)).toBe(ORG_FLOW_VERSION);
    expect(ORG_FLOW_VERSION).toBe(2);
    const old = await mkdtemp(join(tmpdir(), "atticus-orgflow-v1-"));
    expect(await orgFlowVersionOf(old)).toBeUndefined();
    await mkdir(join(old, "openspec/schemas/org-flow/templates"), { recursive: true });
    await writeFile(
      join(old, "openspec/schemas/org-flow/schema.yaml"),
      "name: org-flow\nversion: 1\n",
    );
    await writeFile(join(old, "openspec/schemas/org-flow/templates/snow.md"), "# snow\n");
    expect(await orgFlowVersionOf(old)).toBe(1);
    await writeOrgFlowSchema(old);
    expect(await orgFlowVersionOf(old)).toBe(2);
    expect(existsSync(join(old, "openspec/schemas/org-flow/templates/snow.md"))).toBe(false);
  });

  it("schema.yaml has only fields OpenSpec's schema format allows", () => {
    const s = orgFlowSchema();
    expect(Object.keys(s).sort()).toEqual(["apply", "artifacts", "description", "name", "version"]);
    for (const a of s.artifacts) {
      expect(Object.keys(a).sort()).toEqual([
        "description",
        "generates",
        "id",
        "instruction",
        "requires",
        "template",
      ]);
    }
  });
});
