import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEC_TEMPLATE,
  catalogJsonSchemas,
  deserializeRecord,
  flowFiles,
  loadOrgPack,
  parseRecord,
  readRepoSpec,
  readSpecFindings,
  serializeRecord,
  specDirOf,
  specFindingFingerprint,
  specRelOf,
  specsRelOf,
  specTemplateFor,
  SpecTemplate,
  templateRef,
  writeFlow,
  writeSpecFindings,
  writeSpecHeader,
  type FlowRecord,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

const flow = () => {
  const r = parseRecord(EXAMPLES.Flow);
  if (!r.ok || r.record.kind !== "Flow") throw new Error(JSON.stringify(r));
  return r.record;
};

describe("the Flow record (ADR 0079)", () => {
  it("keeps its own schema version when written and read back", () => {
    const text = serializeRecord(flow());
    expect(text.startsWith("schemaVersion: 1\nkind: Flow\n")).toBe(true);
    const back = deserializeRecord(text);
    expect(back.ok && back.record).toEqual(flow());
    expect(parseRecord({ ...EXAMPLES.Flow, schemaVersion: 2 }).ok).toBe(false);
    const s = catalogJsonSchemas().Flow as { $id: string };
    expect(s.$id).toContain("/schema/flow/v1/Flow.json");
  });

  it("checks the rules across its fields", () => {
    const f = EXAMPLES.Flow as { steps: Record<string, unknown>[] };
    const bad = (patch: Record<string, unknown>, at: number) => {
      const steps = f.steps.map((s, i) => (i === at ? { ...s, ...patch } : s));
      const r = parseRecord({ ...EXAMPLES.Flow, steps });
      return r.ok ? [] : r.issues.map((i) => i.path);
    };
    expect(bad({ kind: "transform", confirmedBy: "check" }, 0)).toEqual(["steps.0.confirmedBy"]);
    expect(bad({ to: undefined }, 2)).toEqual(["steps.2.to"]);
    expect(bad({ kind: "respond" }, 1)).toEqual(["steps.1.store"]);
    expect(bad({ evidence: [] }, 3)).toEqual(["steps.3.evidence"]);
    const id = parseRecord({ ...EXAMPLES.Flow, id: "other.get-balance" });
    expect(!id.ok && id.issues[0]?.path).toBe("id");
    const fam = parseRecord({ ...EXAMPLES.Flow, family: ["ledger-api.get-balance"] });
    expect(!fam.ok && fam.issues[0]?.path).toBe("family");
  });

  it("lists every file it cites", () => {
    expect(flowFiles(flow())).toEqual(["src/main/java/forge/ledger/Api.java"]);
  });
});

describe("spec files (ADR 0079)", () => {
  it("writes and reads specs/<repo>/ and the adopted .atticus/specs/<repo>/", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-spec-"));
    expect(specsRelOf(root)).toBe("specs");
    expect(specRelOf(root, "forge-ledger")).toBe("specs/forge-ledger");
    const rel = await writeFlow(root, "forge-ledger", flow());
    expect(rel).toBe("specs/forge-ledger/ledger-api.get-balance.yaml");
    await writeSpecHeader(root, {
      schemaVersion: 1,
      repo: "forge-ledger",
      template: templateRef(DEFAULT_SPEC_TEMPLATE),
      templateReviewed: false,
      flows: ["ledger-api.get-balance"],
      files: {},
      questions: [],
    });
    await writeFile(join(specDirOf(root, "forge-ledger"), "broken.yaml"), "kind: Flow\n");
    const spec = await readRepoSpec(root, "forge-ledger");
    expect(spec.header?.template).toBe("default@1");
    expect(spec.flows.map((f: FlowRecord) => f.id)).toEqual(["ledger-api.get-balance"]);
    expect(spec.problems.map((p) => p.file)).toEqual(["specs/forge-ledger/broken.yaml"]);
    expect(
      await readFile(join(root, "specs", "forge-ledger", "ledger-api.get-balance.yaml"), "utf8"),
    ).toBe(serializeRecord(flow()));

    await writeSpecFindings(root, {
      schemaVersion: 1,
      repo: "forge-ledger",
      checkedAt: "2026-10-21T12:00:00Z",
      findings: [
        {
          fingerprint: specFindingFingerprint("step-line", "x", "a.java:3"),
          rule: "step-line",
          target: "x",
          message: "m",
          seen: 1,
        },
      ],
    });
    expect((await readSpecFindings(root, "forge-ledger"))?.findings).toHaveLength(1);
    // The findings file isn't read as a flow.
    expect((await readRepoSpec(root, "forge-ledger")).problems).toHaveLength(1);

    const adopted = await mkdtemp(join(tmpdir(), "atticus-spec-adopted-"));
    await mkdir(join(adopted, ".atticus", "org-pack"), { recursive: true });
    expect(specRelOf(adopted, "forge-ledger")).toBe(".atticus/specs/forge-ledger");
  });

  it("loads a repo type's spec template, and falls back to the default", async () => {
    const pack = await mkdtemp(join(tmpdir(), "atticus-spec-pack-"));
    const dir = join(pack, "repo-types", "forge-api");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "type.yaml"),
      [
        "schemaVersion: 1",
        "id: forge-api",
        "name: Forge API",
        "description: A Forge REST service.",
        "fingerprint:",
        "  - { kind: build-file, globs: [pom.xml], weight: 1 }",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "spec-template.yaml"),
      [
        "schemaVersion: 1",
        "repoType: forge-api",
        "version: 2",
        "triggers:",
        "  - kind: endpoint",
        "    from: { kind: Endpoint, endpointType: [rest] }",
        "    why: Every REST entry point.",
        "steps:",
        "  - { kind: write, requires: [store.table, store.columns] }",
      ].join("\n"),
    );
    const op = await loadOrgPack(pack);
    expect(op.problems).toEqual([]);
    expect(op.specTemplates.map(templateRef)).toEqual(["forge-api@2"]);
    expect(templateRef(specTemplateFor(op.specTemplates, "forge-api"))).toBe("forge-api@2");
    expect(specTemplateFor(op.specTemplates, "other")).toBe(DEFAULT_SPEC_TEMPLATE);
    expect(specTemplateFor(op.specTemplates, undefined)).toBe(DEFAULT_SPEC_TEMPLATE);

    await writeFile(
      join(dir, "spec-template.yaml"),
      "schemaVersion: 1\nrepoType: other\nversion: 1\ntriggers: [{ kind: job, why: x }]\n",
    );
    const wrong = await loadOrgPack(pack);
    expect(wrong.problems.map((p) => p.path)).toEqual(["repoType"]);
    expect(SpecTemplate.safeParse({ ...DEFAULT_SPEC_TEMPLATE, triggers: [] }).success).toBe(false);
  });
});
