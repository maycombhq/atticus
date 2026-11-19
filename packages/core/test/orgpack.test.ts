import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLES,
  ChangeType,
  DEFAULT_CHANGE_TYPES,
  DEFAULT_GATES,
  DEFAULT_ROLES,
  DEFAULT_RUNTIME,
  DEFAULT_TEST_STRATEGY,
  addQuickTypeText,
  ChangeTypes,
  FrameworkModel,
  IntegrationPattern,
  loadOrgPack,
  Profile,
  quickPathOf,
  QUICK_CHANGE_TYPE,
  Roles,
  Runtime,
  ServiceRequestTemplate,
} from "../src/index.js";

const msgs = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

describe("built-in defaults", () => {
  it("cover the thirteen roles, eight change types and a gate per phase", () => {
    expect(BUILT_IN_ROLES).toHaveLength(13);
    expect(DEFAULT_CHANGE_TYPES.types.map((t) => t.id)).toEqual([
      "feature",
      "integration",
      "bug-fix",
      "emergency-fix",
      "config-change",
      "tech-debt",
      // ADR 0113: the fast path's type.
      "small-change",
      // ADR 0201: the quick path's type.
      "quick",
    ]);
    expect(DEFAULT_GATES.gates.map((g) => g.phase)).toEqual([
      "define",
      "design",
      "plan",
      "build",
      "qa",
      "release",
    ]);
    expect(DEFAULT_RUNTIME.telemetry.enabled).toBe(false);
    expect(DEFAULT_RUNTIME.retention.runsDays).toBe(30);
    expect(DEFAULT_ROLES.approvals.waiver?.roles).toEqual(["architect"]);
    expect(DEFAULT_TEST_STRATEGY.matrix.length).toBeGreaterThan(0);
  });

  it("make the emergency fix a post-release-review type", () => {
    expect(
      DEFAULT_CHANGE_TYPES.types.find((t) => t.id === "emergency-fix")!.postReleaseReview,
    ).toBe(true);
  });
});

/** ADR 0201: the quick path is a type's shape, not a key. */
describe("the quick change type", () => {
  it("is quick by its shape, and no other built-in type is", () => {
    expect(
      Object.fromEntries(DEFAULT_CHANGE_TYPES.types.map((t) => [t.id, quickPathOf(t)])),
    ).toEqual({
      feature: false,
      integration: false,
      "bug-fix": false,
      "emergency-fix": false,
      "config-change": false,
      "tech-debt": false,
      "small-change": false,
      quick: true,
    });
    const quick = DEFAULT_CHANGE_TYPES.types.find((t) => t.id === "quick")!;
    expect(quick.phases).toEqual(["plan", "build", "release"]);
    expect(quick.artifacts).toEqual(["proposal", "specs", "design", "tasks"]);
    expect(quick.lenses).toEqual(["true", "complete", "safe", "ship"]);
    expect(QUICK_CHANGE_TYPE.name).toBe("Quick path");
  });

  it("takes an organisation's own type of that shape, and none with a stage's artifacts or phases", () => {
    const own = { phases: ["plan", "build"], artifacts: ["proposal", "specs", "tasks"] };
    expect(quickPathOf(own)).toBe(true);
    expect(quickPathOf({ ...own, artifacts: [...own.artifacts, "stories"] })).toBe(false);
    expect(quickPathOf({ ...own, phases: ["define", "plan", "build"] })).toBe(false);
    expect(quickPathOf({ ...own, phases: ["design", "build"] })).toBe(false);
    expect(quickPathOf({ ...own, phases: ["build", "release"] })).toBe(false);
  });

  it("is added at the end of an existing change-types.yaml, every other byte kept", async () => {
    const text = [
      "# Our types. Change through a pull request.",
      "schemaVersion: 2",
      "types:",
      "  - id: feature # the usual one",
      "    name: 'New feature'",
      "    phases: [define, design, plan, build, qa, release]",
      "    artifacts:",
      "      - proposal",
      "      - tasks",
      "    lenses: [ complete ]",
      "  # Forge's own",
      "  - id: forge-hotfix",
      "    name: Forge hotfix",
      "    phases: [build]",
      "    artifacts: [proposal, tasks]   # short",
      "",
    ].join("\n");
    const r = addQuickTypeText(text);
    expect(r.changed).toBe(true);
    expect(r.text.startsWith(text)).toBe(true);
    expect(r.text.slice(text.length)).toBe(
      [
        "  - id: quick",
        "    name: Quick path",
        '    description: "From a requirements file to a plain OpenSpec change: proposal, spec deltas, design and tasks, written by your personas and grounded in the map. No stage runs. One hand-off before build."',
        "    phases: [plan, build, release]",
        "    artifacts: [proposal, specs, design, tasks]",
        '    lenses: ["true", complete, safe, ship]',
        "",
      ].join("\n"),
    );
    const types = ChangeTypes.parse((await import("yaml")).parse(r.text)).types;
    expect(types.map((t) => t.id)).toEqual(["feature", "forge-hotfix", "quick"]);
    expect(types.at(-1)).toEqual(QUICK_CHANGE_TYPE);
    // A second run, a type quick of the organisation's own, and a file that doesn't read: left alone.
    expect(addQuickTypeText(r.text)).toEqual({ text: r.text, changed: false });
    expect(addQuickTypeText("schemaVersion: 2\ntypes: [").changed).toBe(false);
  });

  it("keeps the file's line endings, its indent and a last line with no newline", () => {
    const crlf =
      "schemaVersion: 2\r\ntypes:\r\n- id: feature\r\n  name: F\r\n  phases: [build]\r\n  artifacts: [proposal, tasks]";
    const r = addQuickTypeText(crlf);
    expect(r.text.startsWith(`${crlf}\r\n- id: quick\r\n  name: Quick path\r\n`)).toBe(true);
    expect(r.text.includes("\n") && !/[^\r]\n/.test(r.text)).toBe(true);
    // Keys after the list stay after it.
    const after =
      "types:\n  - id: feature\n    name: F\n    phases: [build]\n    artifacts: [proposal, tasks]\nschemaVersion: 2\n";
    const a = addQuickTypeText(after);
    expect(a.text.endsWith("ship]\nschemaVersion: 2\n")).toBe(true);
    expect(a.text.replace(/ {2}- id: quick\n( {4}.*\n)+/, "")).toBe(after);
  });
});

describe("C6 schemas", () => {
  const type = {
    id: "x",
    name: "X",
    phases: ["define", "build"],
    artifacts: ["proposal", "tasks"],
  };

  it("keeps change-type phases in order and requires a proposal and, with build, tasks", () => {
    expect(msgs(ChangeType.safeParse(type))).toEqual([]);
    expect(msgs(ChangeType.safeParse({ ...type, phases: ["build", "define"] })).join()).toContain(
      "phases go in this order",
    );
    expect(msgs(ChangeType.safeParse({ ...type, artifacts: ["tasks"] }))).toContain(
      "every change type needs a proposal",
    );
    expect(msgs(ChangeType.safeParse({ ...type, artifacts: ["proposal"] }))).toContain(
      "a type with a build phase needs tasks",
    );
    expect(msgs(ChangeType.safeParse({ ...type, approvals: { design: ["architect"] } }))).toContain(
      "approval for design, which this type doesn't use",
    );
  });

  it("checks roles: no redefining built-ins, mappings and approvals name known roles", () => {
    expect(
      msgs(
        Roles.safeParse({
          schemaVersion: 1,
          custom: [{ id: "architect", name: "A", basedOn: "architect" }],
        }),
      ),
    ).toContain("architect is a built-in role");
    expect(
      msgs(Roles.safeParse({ schemaVersion: 1, mappings: [{ group: "g", role: "wizard" }] })),
    ).toContain("unknown role wizard");
    expect(
      msgs(
        Roles.safeParse({
          schemaVersion: 1,
          custom: [{ id: "wizard", name: "W", basedOn: "developer" }],
          mappings: [{ group: "g", role: "wizard" }],
        }),
      ),
    ).toEqual([]);
    expect(msgs(Roles.safeParse({ schemaVersion: 1, approvals: { waiver: {} } }))).toContain(
      "name at least one role, group or person",
    );
  });

  it("refuses secrets in adapter settings and keeps defaults allowed", () => {
    const base = { schemaVersion: 1, assistants: { allowed: ["copilot"], default: "copilot" } };
    expect(
      msgs(
        Runtime.safeParse({
          ...base,
          adapters: { gitHost: { type: "github", settings: { apiToken: "x" } } },
        }),
      ).join(),
    ).toContain("looks like a secret");
    expect(
      msgs(
        Runtime.safeParse({
          ...base,
          adapters: { gitHost: { type: "github", settings: { org: "forge" } } },
        }),
      ),
    ).toEqual([]);
    expect(
      msgs(
        Runtime.safeParse({
          ...base,
          assistants: { allowed: ["copilot"], default: "claude-code" },
        }),
      ),
    ).toContain("the default assistant must be allowed");
    expect(
      msgs(Runtime.safeParse({ ...base, adapters: { gitHost: { type: "sourceforge" } } })).length,
    ).toBeGreaterThan(0);
    expect(Runtime.parse(base).adapters).toEqual({});
  });

  it("validates pattern codes and statuses", () => {
    const p = {
      schemaVersion: 1,
      code: "S.GW.VND",
      name: "n",
      definition: "d",
      interaction: "sync",
      route: "gateway",
      targetType: "vendor",
      source: "s",
      version: "1.0.0",
      status: "confirmed",
    };
    expect(msgs(IntegrationPattern.safeParse(p))).toEqual([]);
    expect(msgs(IntegrationPattern.safeParse({ ...p, code: "sgwvnd" })).length).toBeGreaterThan(0);
    expect(msgs(IntegrationPattern.safeParse({ ...p, status: "maybe" })).length).toBeGreaterThan(0);
  });

  it("stops one alias naming two systems", () => {
    const r = Profile.safeParse({
      schemaVersion: 1,
      platform: "forge",
      name: "Forge",
      systems: [
        { id: "ledger", name: "Ledger", boundary: "product", aliases: ["Core"] },
        { id: "audit", name: "Audit", boundary: "internal", aliases: ["core"] },
      ],
    });
    expect(msgs(r)).toContain('"core" already names ledger');
  });

  it("requires triggers and unique fields on service-desk templates", () => {
    const t = {
      schemaVersion: 1,
      id: "fw",
      name: "FW",
      requestType: "FW",
      fields: [{ name: "Port" }],
      leadTimeDays: 10,
      triggers: [{ kind: "Interface", change: "planned-new" }],
    };
    expect(msgs(ServiceRequestTemplate.safeParse(t))).toEqual([]);
    expect(msgs(ServiceRequestTemplate.safeParse({ ...t, triggers: [] })).length).toBeGreaterThan(
      0,
    );
    expect(
      msgs(
        ServiceRequestTemplate.safeParse({ ...t, fields: [{ name: "Port" }, { name: "Port" }] }),
      ),
    ).toContain("duplicate Port");
  });
});

async function pack(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-orgpack-"));
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(p)), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return dir;
}

describe("roles.yaml is deprecated (ADR 0073)", () => {
  it("still loads and validates a pack that has it, approvals and all", async () => {
    const op = await loadOrgPack(
      await pack({
        "roles.yaml":
          "schemaVersion: 1\nenabledOptional: [sre]\nmappings: [ { group: Forge Delivery, role: delivery-lead } ]\napprovals:\n  release-go-no-go: { roles: [delivery-lead] }\n  catalog-assert: { people: [ari] }\n",
      }),
    );
    expect(op.problems).toEqual([]);
    expect(op.defaulted).not.toContain("roles.yaml");
    expect(op.roles.approvals["catalog-assert"]?.people).toEqual(["ari"]);
  });

  it("still reports a broken one, so an old pack doesn't hide a typo", async () => {
    const op = await loadOrgPack(
      await pack({ "roles.yaml": "schemaVersion: 1\nmappings: [ { group: g, role: wizard } ]\n" }),
    );
    expect(op.problems.map((p) => p.file)).toContain("roles.yaml");
  });
});

describe("loadOrgPack", () => {
  it("works with an empty folder: every file defaults", async () => {
    const op = await loadOrgPack(await pack({}));
    expect(op.problems).toEqual([]);
    // roles.yaml is deprecated (ADR 0073): not having it isn't a default being used.
    expect(op.defaulted).toEqual([
      "change-types.yaml",
      "gates.yaml",
      "runtime.yaml",
      "sources.yaml",
      "test-strategy.yaml",
    ]);
    expect(op.changeTypes).toEqual(DEFAULT_CHANGE_TYPES);
  });

  it("lists every problem with its file instead of stopping at the first", async () => {
    const op = await loadOrgPack(
      await pack({
        "gates.yaml":
          "schemaVersion: 1\ngates:\n  - { id: design, phase: design, approvers: [wizard], checklists: [nope] }\n",
        "runtime.yaml":
          "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\nadapters: { notify: { type: teams, settings: { webhookSecret: x } } }\n",
        "patterns/X.Y.yaml":
          "schemaVersion: 1\ncode: X.Y\nname: n\ndefinition: d\ninteraction: sync\nroute: direct\ntargetType: internal\nsource: s\nversion: 1.0.0\nstatus: confirmed\nchecklist: [missing-rule]\n",
        "profiles/forge/profile.yaml":
          "schemaVersion: 1\nplatform: anvil\nname: F\ngates: [ghost]\n",
        "process/skills/a/SKILL.md": "no front matter",
        "broken.yaml": "",
        "roles.yaml": "schemaVersion: 1\nmappings: [ { group: g, role: wizard } ]\n",
      }),
    );
    const got = op.problems.map((p) => `${p.file}: ${p.message}`);
    expect(got).toEqual(
      expect.arrayContaining([
        "gates.yaml: unknown role wizard",
        "gates.yaml: no checklist pack named nope",
        expect.stringMatching(/^runtime\.yaml: webhookSecret looks like a secret/),
        "patterns/X.Y.yaml: no checklist rule missing-rule",
        "profiles/forge/profile.yaml: says anvil but sits in profiles/forge",
        "profiles/forge/profile.yaml: no gate ghost",
        "process/skills/a/SKILL.md: a skill starts with YAML front matter between --- lines",
        "roles.yaml: unknown role wizard",
      ]),
    );
  });

  it("reads skills' front matter and body", async () => {
    const op = await loadOrgPack(
      await pack({
        "process/skills/x/SKILL.md":
          "---\nid: x\nname: X\ndescription: Does x\nowner: team-a\nsource: wiki\n---\n\n1. Do x.\n",
      }),
    );
    expect(op.problems).toEqual([]);
    expect(op.skills[0]).toMatchObject({ id: "x", status: "active", body: "\n1. Do x.\n" });
  });
});

describe("framework models (ADR 0054)", () => {
  const MESSY = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../fixtures/messy/metarepo/org-pack",
  );

  it("loads frameworks/*.yaml from the org pack, with no problems", async () => {
    const op = await loadOrgPack(MESSY);
    expect(op.problems).toEqual([]);
    expect(op.frameworks.map((f) => f.name)).toEqual(["tide-lantern", "tide-platform"]);
    expect(op.frameworks[1]!.annotations.map((a) => a.name)).toEqual(["InternalApi", "Op"]);
    expect(op.frameworks[0]!.calls.map((c) => c.function)).toEqual(["useApi", "call"]);
  });

  it("refuses an annotation that stands for nothing, and a constant without a source", () => {
    const bad = FrameworkModel.safeParse({
      schemaVersion: 1,
      name: "x",
      packages: ["x"],
      annotations: [{ name: "A", means: [], source: { kind: "code" } }],
      constants: { "C.X": { value: "1" } },
    });
    expect(bad.success).toBe(false);
  });
});
