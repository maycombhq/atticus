import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_STRATEGY, workspaceJsonSchemas } from "@maycombhq/core";
import {
  BUILT_IN_TEMPLATES,
  ChangeFileError,
  DEFAULT_CHANGE_POLICY,
  changeStore,
  detectConflicts,
  isFilled,
  loadChangePolicy,
  loadTemplates,
  newChange,
  ownersFor,
  parseCodeowners,
  pickTemplate,
  scoreRisk,
  testsFor,
  type Footprint,
} from "../src/index.js";
import { FEATURE_OWNERS, FORGE, copyPhase, forgeMetarepo, readText } from "./helpers.js";

const T0 = "2026-10-19T09:00:00Z";

describe("change.yaml and the change store", () => {
  it("writes canonical YAML, reads it back and lists changes in id order", async () => {
    const root = await forgeMetarepo();
    await newChange(root, { title: "Show transfer history", type: "feature", by: "pat", now: T0 });
    await newChange(root, { title: "Add transfer limit", type: "feature", by: "pat", now: T0 });
    await mkdir(join(root, "openspec/changes/archive"), { recursive: true });
    await mkdir(join(root, "openspec/changes/not-a-change"), { recursive: true });
    const store = changeStore(root);
    expect((await store.list()).map((c) => c.id)).toEqual([
      "add-transfer-limit",
      "show-transfer-history",
    ]);
    const c = await store.read("add-transfer-limit");
    const before = await readText(join(root, "openspec/changes/add-transfer-limit/change.yaml"));
    await store.write(c);
    expect(await readText(join(root, "openspec/changes/add-transfer-limit/change.yaml"))).toBe(
      before,
    );
    expect(before.split("\n").slice(0, 6)).toEqual([
      "schemaVersion: 1",
      "id: add-transfer-limit",
      "title: Add transfer limit",
      "type: feature",
      "template: feature",
      "state: define",
    ]);
    expect(await readdir(join(root, "openspec/changes/add-transfer-limit"))).not.toContain(
      "change.yaml.tmp",
    );
  });

  it("refuses a file that breaks the schema, names the file, and never writes an invalid one", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      now: T0,
    });
    const path = join(root, "openspec/changes/add-transfer-limit/change.yaml");
    const store = changeStore(root);
    await expect(store.write({ ...c, state: "plan" })).rejects.toThrow(
      /history ends at define but state is plan/,
    );
    await writeFile(path, (await readText(path)).replace("state: define", "state: plan"));
    const e = await store.read("add-transfer-limit").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChangeFileError);
    expect((e as ChangeFileError).path).toBe(path);
    await writeFile(
      path,
      (await readText(path))
        .replace("state: plan", "state: define")
        .replace("id: add-transfer-limit", "id: other"),
    );
    await expect(store.read("add-transfer-limit")).rejects.toThrow(/says change other/);
  });

  it("checks hand-off branches and allows only one live hand-off", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      now: T0,
    });
    const h = {
      phase: "define" as const,
      branch: "handoff/add-transfer-limit/define",
      pr: { number: 1, url: "https://git.example.com/x/pull/1" },
      state: "open" as const,
      by: "pat",
      openedAt: T0,
      reviewers: [],
      approvals: [],
      artifacts: [],
    };
    const store = changeStore(root);
    await expect(
      store.write({ ...c, handoffs: [{ ...h, branch: "handoff/x/define" }] }),
    ).rejects.toThrow(/the branch is handoff\/add-transfer-limit\/define/);
    await expect(store.write({ ...c, handoffs: [h, h] })).rejects.toThrow(/only one hand-off/);
  });

  it("is exported as JSON Schema with the workspace files", () => {
    const s = workspaceJsonSchemas() as Record<string, { $id: string }>;
    expect(s.ChangeLifecycle!.$id).toBe(
      "https://maycombhq.github.io/atticus/schema/workspace/v1/ChangeLifecycle.json",
    );
  });
});

describe("new changes", () => {
  it("refuses an unknown type or template and an id that exists", async () => {
    const root = await forgeMetarepo();
    await expect(
      newChange(root, { title: "X", type: "vulnerability", by: "pat", now: T0 }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("feature, integration"),
    });
    await expect(
      newChange(root, { title: "X", type: "feature", template: "nope", by: "pat", now: T0 }),
    ).rejects.toMatchObject({ code: "invalid" });
    await newChange(root, { title: "Add transfer limit", type: "feature", by: "pat", now: T0 });
    await expect(
      newChange(root, { title: "Add transfer limit", type: "feature", by: "pat", now: T0 }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses a template's own skeleton when asked, and makes the product owner the creator by default", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Patch the JSON parser",
      type: "bug-fix",
      template: "vulnerability-fix",
      by: "dev",
      now: T0,
    });
    expect(c).toMatchObject({ template: "vulnerability-fix", state: "define" });
    expect(c.owners).toEqual({ "product-owner": ["dev"] });
    const brief = await readText(join(root, "openspec/changes/patch-the-json-parser/brief.md"));
    expect(brief).toContain("## Vulnerability");
    expect(isFilled(brief)).toBe(false);
  });
});

describe("change templates", () => {
  it("has the eight built-in templates, each an empty skeleton", () => {
    expect(BUILT_IN_TEMPLATES.map((t) => t.id)).toEqual([
      "feature",
      "defect-fix",
      "emergency-fix",
      "tech-debt",
      "vulnerability-fix",
      "config-flag",
      "data-fix",
      "decommission",
    ]);
    for (const t of BUILT_IN_TEMPLATES) expect(isFilled(t.body), t.id).toBe(false);
  });

  it("lets the org pack replace a template, and reports broken files", async () => {
    const forge = await loadTemplates(join(FORGE, "metarepo/org-pack"));
    expect(forge.problems).toEqual([]);
    expect(forge.templates.find((t) => t.id === "feature")!.source).toBe(
      "process/change-templates/feature.md",
    );
    expect(forge.templates.filter((t) => t.source === "built-in")).toHaveLength(7);

    const root = await forgeMetarepo();
    const dir = join(root, "org-pack/process/change-templates");
    await writeFile(join(dir, "broken.md"), "# no front matter\n");
    await writeFile(
      join(dir, "odd.md"),
      "---\nid: odd\nname: Odd\nchangeType: feature\n---\n# {{ticket}}\n",
    );
    await writeFile(
      join(dir, "named.md"),
      "---\nid: other\nname: N\nchangeType: feature\n---\n# x\n",
    );
    const r = await loadTemplates(join(root, "org-pack"));
    expect(r.problems.map((p) => p.file)).toEqual([
      "process/change-templates/broken.md",
      "process/change-templates/named.md",
      "process/change-templates/odd.md",
    ]);
    expect(r.problems[2]!.message).toContain("{{ticket}}");
  });

  it("picks the asked-for template, then the type's own, then one for the type, then feature", () => {
    const t = BUILT_IN_TEMPLATES;
    expect(pickTemplate(t, "bug-fix", "data-fix")!.id).toBe("data-fix");
    expect(pickTemplate(t, "emergency-fix")!.id).toBe("emergency-fix");
    expect(pickTemplate(t, "bug-fix")!.id).toBe("defect-fix");
    expect(pickTemplate(t, "something-new")!.id).toBe("feature");
    expect(pickTemplate(t, "feature", "missing")).toBeUndefined();
  });
});

describe("isFilled", () => {
  it("treats headings, comments, empty bullets and table scaffolding as empty", () => {
    expect(isFilled("# T\n\n<!-- c -->\n\n| A | B |\n| --- | --- |\n|  |  |\n- \n")).toBe(false);
    expect(isFilled("# T\n\n| A | B |\n| --- | --- |\n| x |  |\n")).toBe(true);
    expect(isFilled("# T\n\nSome words.\n")).toBe(true);
    expect(isFilled("")).toBe(false);
  });
});

describe("change policy", () => {
  it("uses the built-in policy when the org pack has none", async () => {
    const r = await loadChangePolicy(join(FORGE, "metarepo/org-pack"));
    expect(r).toEqual({ policy: DEFAULT_CHANGE_POLICY, problems: [] });
  });

  it("lets a section be replaced, and never allows self-approval at release", async () => {
    const root = await forgeMetarepo();
    const path = join(root, "org-pack/process/change-policy.yaml");
    await writeFile(path, "schemaVersion: 1\nprivacy:\n  role: data-protection\n");
    const ok = await loadChangePolicy(join(root, "org-pack"));
    expect(ok.problems).toEqual([]);
    expect(ok.policy.privacy).toEqual({
      role: "data-protection",
      classifications: DEFAULT_CHANGE_POLICY.privacy.classifications,
      phases: ["design"],
    });
    expect(ok.policy.risk).toEqual(DEFAULT_CHANGE_POLICY.risk);

    await writeFile(
      path,
      "schemaVersion: 1\nselfApproval:\n  - { phases: [plan, release], roles: [team-lead] }\n",
    );
    const bad = await loadChangePolicy(join(root, "org-pack"));
    expect(bad.problems).toEqual([
      {
        file: "process/change-policy.yaml",
        message: "selfApproval.0.phases: nobody may approve their own change at release",
      },
    ]);
    expect(bad.policy).toEqual(DEFAULT_CHANGE_POLICY);
  });
});

describe("CODEOWNERS", () => {
  const rules = parseCodeowners(
    [
      "# comment",
      "*                       @forge/platform",
      "/openspec/changes/**/design.md  @ari @avery",
      "docs/                   @writers",
      "*.yaml                  @yaml-people",
      "/org-pack/              @forge/platform-leads",
    ].join("\n"),
  );
  it("uses the last matching pattern, like the Git host", () => {
    expect(ownersFor(rules, "openspec/changes/x/design.md")).toEqual(["ari", "avery"]);
    expect(ownersFor(rules, "openspec/changes/x/proposal.md")).toEqual(["forge/platform"]);
    expect(ownersFor(rules, "a/docs/guide.md")).toEqual(["writers"]);
    expect(ownersFor(rules, "openspec/changes/x/change.yaml")).toEqual(["yaml-people"]);
    expect(ownersFor(rules, "org-pack/roles.yaml")).toEqual(["forge/platform-leads"]);
    expect(ownersFor(parseCodeowners(""), "x")).toEqual([]);
  });
});

describe("risk scoring and test strategy", () => {
  const fp = (over: Partial<Footprint>): Footprint => ({
    systems: [],
    components: [],
    interfaces: [],
    dataStores: [],
    tables: [],
    records: [],
    repos: [],
    vendors: [],
    personal: [],
    ...over,
  });

  it("scores from the type, systems, data stores, vendor boundary and planned interfaces", () => {
    const r = scoreRisk(
      {
        type: "integration",
        footprint: fp({
          systems: ["ledger", "northwind-pay", "portal"],
          vendors: ["northwind-pay"],
          dataStores: ["ledger-db", "reports-db"],
          interfaces: [
            { id: "if-a", status: "planned-retire" },
            { id: "if-b", status: "planned-new" },
            { id: "if-c", status: "planned-modify" },
          ],
        }),
      },
      DEFAULT_CHANGE_POLICY,
    );
    expect(r).toEqual({
      score: 14,
      level: "high",
      factors: [
        { factor: "type", detail: "change type integration", points: 2 },
        {
          factor: "systems",
          detail: "3 systems touched (ledger, northwind-pay, portal)",
          points: 2,
        },
        { factor: "data-store", detail: "data store ledger-db", points: 2 },
        { factor: "data-store", detail: "data store reports-db", points: 2 },
        { factor: "vendor", detail: "crosses the vendor boundary (northwind-pay)", points: 3 },
        { factor: "interface", detail: "interface if-a planned-retire", points: 2 },
        { factor: "interface", detail: "interface if-c planned-modify", points: 1 },
      ],
    });
    expect(scoreRisk({ type: "config-change", footprint: fp({}) }, DEFAULT_CHANGE_POLICY)).toEqual({
      score: 1,
      level: "low",
      factors: [{ factor: "type", detail: "change type config-change", points: 1 }],
    });
  });

  it("reads the test strategy matrix, falling back to the nearest risk row and saying so", () => {
    const s = DEFAULT_TEST_STRATEGY;
    expect(testsFor(s, "feature", "high")).toEqual({
      required: ["unit", "contract", "integration", "e2e", "regression", "performance", "security"],
      row: { changeType: "feature", risk: "high" },
    });
    expect(testsFor(s, "bug-fix", "medium")).toEqual({
      required: ["unit", "regression"],
      row: { changeType: "bug-fix", risk: "low" },
      note: "test-strategy.yaml has no bug-fix/medium row; using bug-fix/low.",
    });
    expect(testsFor(s, "emergency-fix", "low")).toMatchObject({
      row: { changeType: "emergency-fix", risk: "high" },
    });
    expect(testsFor(s, "config-change", "low")).toEqual({
      required: [],
      note: "test-strategy.yaml has no row for config-change.",
    });
  });
});

describe("conflict detection", () => {
  it("pairs open changes that touch the same records or repos", async () => {
    const root = await forgeMetarepo();
    await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      owners: FEATURE_OWNERS,
      systems: ["ledger", "portal"],
      now: T0,
    });
    await copyPhase(root, "add-transfer-limit", "add-transfer-limit/design");
    await newChange(root, {
      title: "Show transfer history",
      type: "feature",
      by: "pat",
      systems: ["portal"],
      touches: { interfaces: [{ id: "if-75b5e8d8aa780837", status: "planned-modify" }] },
      now: T0,
    });
    await newChange(root, {
      title: "Fix Northwind timeout",
      type: "emergency-fix",
      by: "dev",
      systems: ["ledger", "northwind-pay"],
      touches: {
        interfaces: [{ id: "if-e7344c9455608119", status: "planned-modify" }],
        tables: ["ledger-db.account"],
      },
      now: T0,
    });
    await newChange(root, {
      title: "Reports CSV",
      type: "feature",
      by: "pat",
      systems: ["reports"],
      touches: { repos: ["forge-reports-job"] },
      now: T0,
    });
    const store = changeStore(root);
    const old = await newChange(root, {
      title: "Old ledger change",
      type: "feature",
      by: "pat",
      systems: ["ledger"],
      now: T0,
    });
    await store.write({
      ...old,
      state: "archived",
      history: [...old.history, { from: "define", to: "archived", at: T0, by: "pat" }],
    });

    const none = { interfaces: [], records: [] };
    expect(await detectConflicts(root)).toEqual([
      {
        changes: ["add-transfer-limit", "fix-northwind-timeout"],
        overlap: {
          ...none,
          systems: ["ledger"],
          dataStores: ["ledger-db"],
          tables: ["ledger-db.account"],
          repos: ["forge-ledger"],
        },
      },
      {
        changes: ["add-transfer-limit", "show-transfer-history"],
        overlap: {
          ...none,
          systems: ["ledger", "portal"],
          dataStores: [],
          tables: [],
          repos: ["forge-ledger", "forge-portal-bff"],
        },
      },
      {
        changes: ["fix-northwind-timeout", "show-transfer-history"],
        overlap: {
          ...none,
          systems: ["ledger"],
          dataStores: [],
          tables: [],
          repos: ["forge-ledger"],
        },
      },
    ]);
  });
});
