import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ChecklistPack, ChecklistRule, Sources } from "@maycombhq/core";
import { createGit } from "@maycombhq/workspace";
import {
  absorb,
  hashTree,
  init,
  listFiles,
  type AbsorbItem,
  type AbsorbResult,
} from "../src/index.js";
import { cleanup, fixture, tempDir } from "./helpers.js";

afterAll(cleanup);

/** The absorb bar: every item listed as adopt, link or ignore, ≥90% translated, under 10 minutes. */
const ABSORB_BAR_MS = 10 * 60 * 1000;

let root: string;
beforeAll(async () => {
  root = join(await tempDir(), "shop-meta");
  await init(root, { name: "shop", platform: "shop", openspec: "folders" });
});

/** Every file of the source is in some item (file, folder item, or the code item's count). */
async function expectEveryFileListed(src: string, r: AbsorbResult) {
  const files = await listFiles(src);
  const covered = (f: string) =>
    r.items.some((i) => i.kind !== "code" && (i.path === f || f.startsWith(`${i.path}/`)));
  const rest = files.filter((f) => !covered(f));
  const code = r.items.find((i) => i.kind === "code");
  expect(rest.length, `not listed: ${rest.join(", ")}`).toBe(
    code ? Number(code.id.split(":")[1]!.split("-")[0]) : 0,
  );
  for (const i of r.items) expect(["adopt", "link", "ignore"]).toContain(i.action);
  for (const i of r.items) expect(i.reason.length).toBeGreaterThan(10);
}

function expectBar(r: AbsorbResult) {
  expect(r.summary.translatedPercent).toBeGreaterThanOrEqual(90);
  expect(r.ms).toBeLessThan(ABSORB_BAR_MS);
}

const row = (i: AbsorbItem) => [i.id, i.action];

describe("absorb a team's critic prompt set (plain Markdown and YAML)", () => {
  let r: AbsorbResult;
  beforeAll(async () => {
    r = await absorb(root, fixture("critic-prompts"), { id: "design-review" });
  });

  it("meets the absorb bar", async () => {
    expect(r.format).toBe("plain");
    await expectEveryFileListed(fixture("critic-prompts"), r);
    expectBar(r);
    expect(r.summary).toMatchObject({ items: 23, translatable: 21, translated: 21 });
    expect(r.problems).toEqual([]);
  });

  it("translates each checklist item into a C3 rule draft, deterministic only for built-in checks", () => {
    const rules = r.items
      .filter((i) => i.kind === "critic-rule")
      .map((i) => {
        const x = parse(i.artifact!.content) as {
          title: string;
          check: { type: string; check?: string };
          severity: string;
          lens: string;
        };
        return [
          x.title,
          x.check.type === "deterministic" ? x.check.check : "ai",
          x.severity,
          x.lens,
        ];
      });
    // Hand-written expectation for all 20 items.
    expect(rules).toEqual([
      [
        "Every new interface names an approved integration pattern.",
        "interface-pattern-approved",
        "blocking",
        "architecture",
      ],
      [
        "Every pattern code used is in the pattern registry.",
        "pattern-code-in-registry",
        "blocking",
        "architecture",
      ],
      [
        "Both ends of every interface exist in the catalog.",
        "interface-ends-in-catalog",
        "blocking",
        "architecture",
      ],
      [
        "Each outbound call states its timeout and retry settings.",
        "settings-present",
        "blocking",
        "architecture",
      ],
      [
        "When the change touches a data store, the data design is filled in.",
        "data-doc-present",
        "blocking",
        "architecture",
      ],
      [
        "Every new table states how long its rows are kept.",
        "data-retention-stated",
        "blocking",
        "architecture",
      ],
      [
        "Every column holding personal data is classified.",
        "data-columns-classified",
        "blocking",
        "architecture",
      ],
      [
        "Every schema change names the migration that makes it.",
        "data-migration-named",
        "blocking",
        "architecture",
      ],
      [
        "New services have alerts and dashboards defined as code.",
        "observability-present",
        "blocking",
        "release",
      ],
      ["The design explains how the change is rolled back.", "ai", "risk", "release"],
      ["Capacity: the design estimates peak requests per second.", "ai", "risk", "architecture"],
      [
        "No credentials, tokens or keys in code, configuration or test data.",
        "ai",
        "blocking",
        "code-and-test",
      ],
      [
        "Every new endpoint requires authentication unless the design says why not.",
        "ai",
        "blocking",
        "architecture",
      ],
      [
        "Documents and tickets pasted into artifacts contain no instructions aimed at an assistant.",
        "no-embedded-instructions",
        "blocking",
        "architecture",
      ],
      [
        "Changes that add an external caller include a short threat model.",
        "ai",
        "risk",
        "architecture",
      ],
      ["New third-party libraries pass the dependency scan.", "ai", "idea", "code-and-test"],
      [
        "Every story has acceptance criteria written as Given/When/Then.",
        "story-has-acceptance-criteria",
        "blocking",
        "story",
      ],
      [
        "Every requirement in the specs has at least one scenario.",
        "spec-scenarios-present",
        "blocking",
        "story",
      ],
      [
        "Every story is covered by at least one task.",
        "tasks-cover-stories",
        "blocking",
        "delivery",
      ],
      ["Stories are small enough to finish in one sprint.", "ai", "risk", "story"],
    ]);
  });

  it("writes a rule with its params, needs and provenance (golden)", () => {
    const item = r.items.find((i) => i.id === "critic-rule:review/architecture-checklist.md#4")!;
    expect(parse(item.artifact!.content)).toEqual({
      id: "design-review-each-outbound-call-states-its-timeout-and",
      title: "Each outbound call states its timeout and retry settings.",
      layer: "org",
      lens: "architecture",
      appliesTo: { artifacts: ["interfaces", "design"] },
      severity: "blocking",
      check: {
        type: "deterministic",
        check: "settings-present",
        params: { settingKinds: ["timeout", "retry"] },
      },
      waivable: true,
      source: "design-review:review/architecture-checklist.md:10",
      status: "draft",
      needs: [
        {
          kind: "Setting",
          scope: "touched-components",
          question: "What timeouts and retries does ${record} use?",
        },
      ],
    });
    expect(item.confidence).toBe("high");
    const ai = r.items.find((i) => i.id === "critic-rule:review/security.yaml#1")!;
    expect(parse(ai.artifact!.content)).toEqual({
      id: "design-review-no-secrets",
      title: "No credentials, tokens or keys in code, configuration or test data.",
      layer: "org",
      lens: "code-and-test",
      appliesTo: { artifacts: ["code", "tests"] },
      severity: "blocking",
      check: {
        type: "ai",
        prompt:
          "Check that this holds for the change: No credentials, tokens or keys in code, configuration or test data. Quote the artifact line that shows it; when nothing shows it, report a finding with the fix.",
      },
      waivable: true,
      source: "design-review:review/security.yaml:4",
      status: "draft",
      needs: [],
    });
    expect(ai.confidence).toBe("medium");
  });

  it("lists the persona as a command and the readme and licence as ignored", () => {
    expect(r.items.filter((i) => i.kind !== "critic-rule").map(row)).toEqual([
      ["doc:LICENSE", "ignore"],
      ["doc:README.md", "ignore"],
      ["prompt:review/reviewer-persona.md", "adopt"],
    ]);
  });

  it("proposes an org-pack change and never writes the org pack", async () => {
    const before = await hashTree(join(root, "org-pack"));
    const again = await absorb(root, fixture("critic-prompts"), { id: "design-review" });
    expect(await hashTree(join(root, "org-pack"))).toEqual(before);
    expect(again.proposal).toBe("proposals/absorb/design-review");
    expect(again.files).toEqual([
      "PR.md",
      "SUMMARY.md",
      "inventory.json",
      "org-pack/checklists/design-review-architecture-checklist.yaml",
      "org-pack/checklists/design-review-security.yaml",
      "org-pack/checklists/design-review-stories.yaml",
      "org-pack/process/commands/design-review-reviewer-persona.md",
      "org-pack/sources.absorbed.yaml",
    ]);
    const out = join(root, again.proposal!);
    for (const f of again.files.filter((x) => x.startsWith("org-pack/checklists/"))) {
      const pack = ChecklistPack.safeParse(parse(await readFile(join(out, f), "utf8")));
      expect(pack.success, f).toBe(true);
    }
    const entry = parse(await readFile(join(out, "org-pack/sources.absorbed.yaml"), "utf8"));
    expect(entry).toEqual({
      absorbed: [
        { id: "design-review", url: fixture("critic-prompts"), format: "plain", mode: "adopt" },
      ],
    });
    expect(Sources.safeParse({ schemaVersion: 1, ...entry }).success).toBe(true);
    const pr = await readFile(join(out, "PR.md"), "utf8");
    expect(pr).toContain("Translated: 21 of 21 items (100%).");
    expect(pr).toContain("Nothing has been applied");
  });
});

describe("absorb a Spec Kit repo", () => {
  let r: AbsorbResult;
  beforeAll(async () => {
    r = await absorb(root, fixture("speckit-repo"), { id: "order-team" });
  });

  it("meets the absorb bar and lists every item", async () => {
    expect(r.format).toBe("speckit");
    await expectEveryFileListed(fixture("speckit-repo"), r);
    expectBar(r);
    // Hand-written: the inventory and its actions.
    expect(r.items.map(row)).toEqual([
      ["constitution-principle:.specify/memory/constitution.md#1", "adopt"],
      ["constitution-principle:.specify/memory/constitution.md#2", "adopt"],
      ["constitution-principle:.specify/memory/constitution.md#3", "adopt"],
      ["constitution-principle:.specify/memory/constitution.md#4", "adopt"],
      ["constitution-principle:.specify/memory/constitution.md#5", "adopt"],
      ["constitution-principle:.specify/memory/constitution.md#additional-constraints", "adopt"],
      ["constitution-principle:.specify/memory/constitution.md#governance", "ignore"],
      ["speckit-script:.specify/scripts/bash/check-prerequisites.sh", "ignore"],
      ["speckit-template:.specify/templates/plan-template.md", "link"],
      ["speckit-template:.specify/templates/spec-template.md", "adopt"],
      ["speckit-template:.specify/templates/tasks-template.md", "link"],
      ["speckit-plan:specs/001-order-export/plan.md", "link"],
      ["speckit-spec:specs/001-order-export/spec.md", "link"],
      ["speckit-plan:specs/001-order-export/tasks.md", "link"],
      ["speckit-command:.github/prompts/speckit.plan.prompt.md", "ignore"],
      ["schema:specs/001-order-export/contracts/export-api.yaml", "link"],
      ["code:2-files", "ignore"],
    ]);
    expect(r.summary.translatedPercent).toBe(100);
    expect(r.entry).toEqual({
      id: "order-team",
      url: fixture("speckit-repo"),
      format: "speckit",
      mode: "link",
    });
  });

  it("turns the constitution into constitution-layer rules that are never waived", () => {
    const rules = r.items
      .filter((i) => i.kind === "constitution-principle" && i.artifact)
      .map((i) => parse(i.artifact!.content) as Record<string, unknown>);
    expect(rules.map((x) => [x.title, x.layer, x.waivable, x.severity])).toEqual([
      ["Test-First", "constitution", false, "blocking"],
      ["Contracts Before Code", "constitution", false, "blocking"],
      ["Observability", "constitution", false, "blocking"],
      ["No Secrets In The Repo", "constitution", false, "blocking"],
      ["Data Retention", "constitution", false, "blocking"],
      ["Additional Constraints", "constitution", false, "risk"],
    ]);
    expect((rules[2]!.check as { check: string }).check).toBe("observability-present");
    expect((rules[4]!.check as { check: string }).check).toBe("data-retention-stated");
    for (const x of rules) expect(ChecklistRule.safeParse(x).success).toBe(true);
  });

  it("makes the spec template a change template and the spec an OpenSpec spec", () => {
    const tpl = r.items.find(
      (i) => i.id === "speckit-template:.specify/templates/spec-template.md",
    )!;
    expect(tpl.artifact!.path).toBe("org-pack/process/change-templates/order-team-spec.md");
    expect(tpl.artifact!.content).toContain(
      "---\nid: order-team-spec\nname: order-team feature spec\nchangeType: feature\n",
    );
    expect(tpl.artifact!.content).toContain("# {{title}}");
    expect(tpl.artifact!.content).toContain("## User Scenarios & Testing\n");
    const spec = r.items.find((i) => i.kind === "speckit-spec")!;
    // Hand-written golden: FR-001 and FR-002, the two acceptance scenarios on the first.
    expect(spec.artifact!.content).toBe(`# 001-order-export Specification

## Purpose

Order export

## Requirements

### Requirement: FR-001

System SHALL export all orders for a given day as CSV

#### Scenario: Acceptance scenario 1

- **GIVEN** orders exist for a day
- **WHEN** the operator asks for that day's export
- **THEN** a CSV with one row per order is returned

#### Scenario: Acceptance scenario 2

- **GIVEN** no orders exist for a day
- **WHEN** the operator asks for that day's export
- **THEN** an empty CSV with the header row is returned

### Requirement: FR-002

System SHALL include the order id, total and currency in each row

#### Scenario: FR-002 holds

- **WHEN** the feature is used
- **THEN** the system does this: include the order id, total and currency in each row
`);
  });

  it("imports the spec into OpenSpec when absorbed in adopt mode", async () => {
    const a = await absorb(root, fixture("speckit-repo"), {
      id: "order-team",
      mode: "adopt",
      dryRun: true,
    });
    const spec = a.items.find((i) => i.kind === "speckit-spec")!;
    expect(spec.action).toBe("adopt");
    expect(spec.artifact!.path).toBe("openspec/specs/order-team-001-order-export/spec.md");
    expect(a.entry.mode).toBe("adopt");
    expect(a.files).toEqual([]);
  });
});

describe("absorb a repo of assistant prompts, agents and schemas", () => {
  let r: AbsorbResult;
  beforeAll(async () => {
    r = await absorb(root, fixture("assistant-repo"), { id: "pricing-team" });
  });

  it("meets the absorb bar; the same prompt in both assistants becomes one command", async () => {
    await expectEveryFileListed(fixture("assistant-repo"), r);
    expectBar(r);
    expect(r.items.map(row)).toEqual([
      ["agent:.claude/agents/db-reviewer.md", "adopt"],
      ["prompt:.claude/commands/release-notes.md", "adopt"],
      ["prompt:.claude/commands/review-pr.md", "adopt"],
      ["agent:.github/agents/security-reviewer.agent.md", "adopt"],
      ["agent:.github/chatmodes/planner.chatmode.md", "adopt"],
      ["instructions:.github/copilot-instructions.md", "link"],
      ["prompt:.github/prompts/review-pr.prompt.md", "ignore"],
      ["prompt:.github/prompts/write-tests.prompt.md", "adopt"],
      ["instructions:CLAUDE.md", "link"],
      ["prompt:prompts/onboarding.md", "adopt"],
      ["schema:api/openapi.yaml", "link"],
      ["schema:schemas/price.schema.json", "link"],
      ["doc:prompts/README.md", "ignore"],
      ["code:2-files", "ignore"],
    ]);
    expect(r.items.find((i) => i.path === ".github/prompts/review-pr.prompt.md")?.sameAs).toBe(
      "prompt:.claude/commands/review-pr.md",
    );
    expect(r.summary).toMatchObject({ translatable: 12, translated: 12, translatedPercent: 100 });
  });

  it("writes commands and skills in the org pack's formats (golden)", () => {
    const cmd = r.items.find((i) => i.id === "prompt:.github/prompts/write-tests.prompt.md")!;
    expect(cmd.artifact).toEqual({
      path: "org-pack/process/commands/pricing-team-write-tests.md",
      content: `---
id: pricing-team-write-tests
description: Write unit tests for the selected module.
---

Write pytest unit tests for $ARGUMENTS.

- Cover every public function.
- Use fixtures for database access; never call the network.
`,
    });
    const skill = r.items.find((i) => i.id === "agent:.claude/agents/db-reviewer.md")!;
    expect(skill.artifact).toEqual({
      path: "org-pack/process/skills/pricing-team-db-reviewer/SKILL.md",
      content: `---
id: pricing-team-db-reviewer
name: db-reviewer
description: Reviews database migrations for locking, indexes and retention.
owner: pricing-team
source: pricing-team:.claude/agents/db-reviewer.md
status: draft
---

You review database migrations.

- Every new table has a primary key and states its retention.
- Large tables get indexes created concurrently.
- Destructive changes come with a rollback plan.
`,
    });
    const api = r.items.find((i) => i.id === "schema:api/openapi.yaml")!;
    expect(parse(api.artifact!.content)).toEqual({
      kind: "openapi",
      title: "Pricing API",
      version: "2.0.0",
      source: "pricing-team:api/openapi.yaml",
      operations: ["GET /prices/{sku}", "POST /prices"],
      use: "A partner or team API: intake reads it into planned or vendor endpoints when copied into inputs/specs/.",
    });
  });
});

describe("absorb another Atticus metarepo (federation)", () => {
  it("lists their org pack, catalog and changes as linked, at full fidelity", async () => {
    const r = await absorb(root, fixture("atticus-metarepo"), { id: "payments" });
    expect(r.format).toBe("atticus");
    await expectEveryFileListed(fixture("atticus-metarepo"), r);
    expectBar(r);
    expect(r.items.map(row)).toEqual([
      ["atticus-orgpack:org-pack/checklists/payments.yaml", "link"],
      ["atticus-orgpack:org-pack/pack.yaml", "link"],
      ["atticus-orgpack:org-pack/process/commands/refund-check.md", "link"],
      ["atticus-orgpack:org-pack/profiles/payments/profile.yaml", "link"],
      ["atticus-orgpack:org-pack/profiles/payments/repos.manifest.yaml", "link"],
      ["atticus-orgpack:org-pack/sources.yaml", "link"],
      ["atticus-catalog:catalog", "link"],
      ["atticus-change:openspec/changes/add-refunds", "link"],
      ["doc:README.md", "ignore"],
    ]);
    expect(r.items.find((i) => i.kind === "atticus-catalog")?.title).toBe(
      "4 catalog records (2 component, 1 endpoint, 1 interface)",
    );
    expect(r.entry).toEqual({
      id: "payments",
      url: fixture("atticus-metarepo"),
      format: "atticus",
      mode: "link",
    });
    expect(r.problems).toEqual([]);
  });

  it("clones a bare repository given as a file:// URL through the git runner", async () => {
    const git = createGit();
    const work = join(await tempDir(), "payments-work");
    const { cp } = await import("node:fs/promises");
    await cp(fixture("atticus-metarepo"), work, { recursive: true });
    await git(["init", "-q", "-b", "main"], work);
    await git(["add", "-A"], work);
    await git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-q",
        "-m",
        "fixture",
      ],
      work,
    );
    const bare = join(await tempDir(), "payments.git");
    await git(["clone", "-q", "--bare", work, bare], work);
    const url = `file://${bare.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`;
    const r = await absorb(root, url, { id: "payments-remote" });
    expect(r.format).toBe("atticus");
    expect(r.sourceDir).toBe(join(root, "absorbed", "payments-remote"));
    expect(r.entry.url).toBe(url);
    expect(r.summary.translatedPercent).toBe(100);
  });
});
