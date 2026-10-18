import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLES,
  ChangeType,
  DEFAULT_CHANGE_TYPES,
  DEFAULT_GATES,
  DEFAULT_ROLES,
  DEFAULT_RUNTIME,
  DEFAULT_TEST_STRATEGY,
  IntegrationPattern,
  loadOrgPack,
  Profile,
  Roles,
  Runtime,
  ServiceRequestTemplate,
} from "../src/index.js";

const msgs = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

describe("built-in defaults", () => {
  it("cover the thirteen roles, six change types and a gate per phase", () => {
    expect(BUILT_IN_ROLES).toHaveLength(13);
    expect(DEFAULT_CHANGE_TYPES.types.map((t) => t.id)).toEqual([
      "feature",
      "integration",
      "bug-fix",
      "emergency-fix",
      "config-change",
      "tech-debt",
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

describe("loadOrgPack", () => {
  it("works with an empty folder: every file defaults", async () => {
    const op = await loadOrgPack(await pack({}));
    expect(op.problems).toEqual([]);
    expect(op.defaulted).toEqual([
      "roles.yaml",
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
