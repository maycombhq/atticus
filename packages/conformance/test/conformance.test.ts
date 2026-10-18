import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord, type ExecutorConfig } from "@maycombhq/core";
import { REFERENCE_EXECUTOR } from "@maycombhq/executors";
import { conformanceRun, guarded, type ConformanceReport } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const FORGE = join(HERE, "../../../fixtures/forge");
const SAMPLE = join(HERE, "../sample");

/** Fails and warnings only, as check | status | file | message, for exact comparison. */
const problems = (r: ConformanceReport) =>
  r.results
    .filter((x) => x.status !== "pass")
    .map((x) => [x.check, x.status, x.file ?? "", x.message]);
const passes = (r: ConformanceReport) =>
  r.results.filter((x) => x.status === "pass").map((x) => x.check);

describe("catalog", () => {
  it("golden: the Forge expected catalog, written as files, conforms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conf-catalog-"));
    const rows = parse(await readFile(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const p = parseRecord({ schemaVersion: 2, status: "current", ...row });
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const file = join(dir, "generated", recordPath(p.record));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
    }
    const r = await conformanceRun(dir, { kind: "catalog" });
    expect(problems(r)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(passes(r)).toEqual([
      "catalog.layout",
      "catalog.version",
      "catalog.canonical",
      "catalog.path",
      "catalog.folder",
      "catalog.unique-id",
      "catalog.references",
      "catalog.evidence",
      "catalog.count",
    ]);
    expect(r.results.at(-1)!.message).toBe(`${rows.length} records read.`);
  });

  it("golden: a deliberately broken catalog reports every problem with its file", async () => {
    const r = await conformanceRun(join(FIX, "catalog-broken"), { kind: "catalog" });
    expect(r.passed).toBe(false);
    expect(problems(r)).toEqual([
      [
        "catalog.folder",
        "fail",
        "curated/system/ledger.yaml",
        "Only curated decisions belong in curated/.",
      ],
      [
        "catalog.canonical",
        "fail",
        "generated/component/ledger-api.yaml",
        "Not in canonical form (key order, defaults or quoting).",
      ],
      [
        "catalog.path",
        "fail",
        "generated/component/wrong-name.yaml",
        "Should be at generated/component/ledger-web.yaml.",
      ],
      [
        "catalog.schema",
        "fail",
        "generated/endpoint/bad.yaml",
        expect.stringContaining("pathOrTopic"),
      ],
      [
        "catalog.kind",
        "warn",
        "generated/notes.yaml",
        "Not a catalog record (no known kind); ignored.",
      ],
      [
        "catalog.yaml",
        "fail",
        "generated/system/broken.yaml",
        expect.stringContaining("Not valid YAML"),
      ],
      [
        "catalog.version",
        "fail",
        "generated/system/old.yaml",
        "Written at schema version 1; the current version is 2 (run atticus catalog migrate).",
      ],
      [
        "catalog.unique-id",
        "fail",
        "generated/system/ledger.yaml",
        "Same System id as curated/system/ledger.yaml.",
      ],
      [
        "catalog.references",
        "warn",
        "generated/component/wrong-name.yaml",
        "system points at missing-system, which isn't in this catalog.",
      ],
    ]);
    expect(r.summary).toEqual({ pass: 3, fail: 7, warn: 2 });
  });

  it("finds the catalog of a metarepo root, and fails a folder with no catalog", async () => {
    const empty = await mkdtemp(join(tmpdir(), "conf-empty-"));
    const r = await conformanceRun(empty, { kind: "catalog" });
    expect(problems(r)).toEqual([
      [
        "catalog.layout",
        "fail",
        "",
        `No generated/ or curated/ folder in ${join(empty, "catalog")}.`,
      ],
    ]);
  });
});

describe("org pack", () => {
  it("golden: the Forge org pack conforms, its dialect passing its tests", async () => {
    const r = await conformanceRun(join(FORGE, "metarepo"), { kind: "org-pack" });
    expect(problems(r)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.results.find((x) => x.check === "orgpack.dialect-tests")!.message).toBe(
      "Every dialect passes its tests (forge).",
    );
  });

  it("golden: a deliberately broken org pack", async () => {
    const r = await conformanceRun(join(FIX, "orgpack-broken"), { kind: "org-pack" });
    expect(r.passed).toBe(false);
    expect(problems(r)).toEqual([
      ["orgpack.schema", "fail", "gates.yaml", "design.approvers: unknown role wizard"],
      [
        "orgpack.schema",
        "fail",
        "gates.yaml",
        "design.checklists: no checklist pack named missing-pack",
      ],
      ["orgpack.manifest", "warn", "", "No pack.yaml: the pack has no name or version."],
      [
        "orgpack.dialect-tests",
        "fail",
        "dialects/tags.yaml",
        "tags: names the billing service: expected Component invoicing, got billing",
      ],
    ]);
  });
});

describe("dialect", () => {
  it("golden: a dialect whose tests pass", async () => {
    const r = await conformanceRun(join(FIX, "dialects/good/tags.yaml"), { kind: "dialect" });
    expect(r.results.map((x) => [x.check, x.status, x.message])).toEqual([
      ["dialect.schema", "pass", "Dialect tags 0.1.0 matches C2."],
      ["dialect.tests", "pass", "All 1 tests pass."],
    ]);
  });

  it("golden: the Forge dialect, with fixture-folder tests", async () => {
    const r = await conformanceRun(join(FORGE, "metarepo/org-pack/dialects/forge.yaml"), {
      kind: "dialect",
    });
    expect(problems(r)).toEqual([]);
  });

  it("golden: a failing test and a missing parent", async () => {
    const r = await conformanceRun(join(FIX, "dialects/broken/tags.yaml"), { kind: "dialect" });
    expect(problems(r)).toEqual([
      ["dialect.extends", "fail", "", "Extends house-base, which isn't in the same folder."],
      ["dialect.tests", "fail", "", "Tests not run: they need the dialects it extends."],
    ]);
  });

  it("golden: a failing test", async () => {
    const r = await conformanceRun(join(FIX, "orgpack-broken/dialects/tags.yaml"), {
      kind: "dialect",
    });
    expect(problems(r)).toEqual([
      [
        "dialect.tests",
        "fail",
        "",
        "names the billing service: expected Component invoicing, got billing",
      ],
    ]);
  });

  it("golden: a file that isn't valid C2", async () => {
    const r = await conformanceRun(join(FIX, "dialects/invalid/tags.yaml"), { kind: "dialect" });
    expect(r.passed).toBe(false);
    expect(r.results.every((x) => x.check === "dialect.schema" && x.status === "fail")).toBe(true);
    expect(r.results.map((x) => x.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("version"),
        expect.stringContaining("colour"),
        expect.stringContaining("every dialect ships at least one test"),
      ]),
    );
  });
});

describe("plugin", () => {
  it("golden: a conforming extractor over the sample repo", async () => {
    const r = await conformanceRun(join(FIX, "plugins/good-extractor.mjs"), { kind: "plugin" });
    expect(r.results.map((x) => [x.check, x.status, x.message])).toEqual([
      ["plugin.exports", "pass", "Found extractor greetings."],
      ["plugin.shape", "pass", "extractor greetings 1.0.0 has an id, a semver version and claims."],
      ["plugin.network", "pass", "extractor greetings made no network call."],
      ["plugin.run", "pass", "extractor greetings ran and emitted 1 record."],
      ["plugin.records", "pass", "Every record extractor greetings emitted is valid C1."],
      [
        "plugin.determinism",
        "pass",
        "extractor greetings gave identical output on two runs at two clock times.",
      ],
    ]);
  });

  it("golden: an extractor that phones home, reads the clock and emits an invalid record", async () => {
    const r = await conformanceRun(join(FIX, "plugins/leaky-extractor.mjs"), { kind: "plugin" });
    expect(problems(r)).toEqual([
      [
        "plugin.network",
        "fail",
        "",
        "extractor leaky tried to reach the network: fetch https://telemetry.example/ping.",
      ],
      [
        "plugin.records",
        "fail",
        "",
        "extractor leaky emitted an invalid record: evidence: every record needs at least one piece of evidence",
      ],
      [
        "plugin.determinism",
        "fail",
        "",
        "extractor leaky gave different output on two runs (at two clock times): it must read files only, with no clock or randomness.",
      ],
    ]);
    // The network and the clock are back to normal afterwards.
    expect(typeof globalThis.fetch).toBe("function");
    expect(new Date().getUTCFullYear()).toBeGreaterThan(2000);
  });

  it("golden: an extractor with the wrong shape", async () => {
    const r = await conformanceRun(join(FIX, "plugins/bad-shape.mjs"), { kind: "plugin" });
    expect(problems(r)).toEqual([
      ["plugin.shape", "fail", "", 'extractor Bad_Id: id "Bad_Id" must be a lowercase slug.'],
      ["plugin.shape", "fail", "", 'extractor Bad_Id: version "one" must be semver.'],
      [
        "plugin.shape",
        "fail",
        "",
        "extractor Bad_Id: claims must be a non-empty list of file globs.",
      ],
    ]);
  });

  it("golden: a conforming ingestor over the sample inputs", async () => {
    const r = await conformanceRun(join(FIX, "plugins/good-ingestor.mjs"), {
      kind: "plugin",
      inputs: [join(SAMPLE, "inputs/notes.md"), join(SAMPLE, "inputs/systems.csv")],
    });
    expect(r.results.map((x) => [x.check, x.status, x.message])).toEqual([
      ["plugin.exports", "pass", "Found ingestor systems-csv."],
      [
        "plugin.shape",
        "pass",
        "ingestor systems-csv 1.0.0 has an id, a semver version, sniff and ingest.",
      ],
      ["plugin.network", "pass", "ingestor systems-csv made no network call."],
      ["plugin.run", "pass", "ingestor systems-csv ran and emitted 2 records."],
      ["plugin.records", "pass", "Every record ingestor systems-csv emitted is valid C1."],
      [
        "plugin.determinism",
        "pass",
        "ingestor systems-csv gave identical output on two runs at two clock times.",
      ],
    ]);
  });

  it("golden: a module that exports no plugin", async () => {
    const r = await conformanceRun(join(FIX, "plugins/no-exports.mjs"), { kind: "plugin" });
    expect(problems(r)).toEqual([
      [
        "plugin.exports",
        "fail",
        "",
        "The module exports no extractor (scan) and no ingestor (sniff and ingest).",
      ],
    ]);
  });

  it("the built-in extractors conform, the vocabulary ones included", async () => {
    const r = await conformanceRun(join(HERE, "../../extractors/dist/index.js"), {
      kind: "plugin",
    });
    expect(problems(r)).toEqual([]);
    expect(r.results.find((x) => x.check === "plugin.exports")!.message).toContain(
      "extractor openapi",
    );
    const v = await conformanceRun(join(HERE, "../../extractors/dist/vocab/index.js"), {
      kind: "plugin",
    });
    expect(problems(v)).toEqual([]);
    expect(v.results.filter((x) => x.check === "plugin.determinism")).toHaveLength(11);
  });
});

describe("network guard", () => {
  it("blocks every way out and restores them", async () => {
    const http = await import("node:http");
    const net = await import("node:net");
    const r = await guarded(async () => {
      const tries: string[] = [];
      for (const f of [
        () => globalThis.fetch("https://example.invalid/"),
        () => http.request("http://example.invalid/"),
        () => net.connect(80, "example.invalid"),
      ])
        try {
          await f();
        } catch (e) {
          tries.push((e as Error).name);
        }
      return tries;
    });
    expect(r.value).toEqual(["NetworkBlocked", "NetworkBlocked", "NetworkBlocked"]);
    expect(r.attempts).toEqual([
      "fetch https://example.invalid/",
      "http.request http://example.invalid/",
      "net.connect",
    ]);
    expect(http.request.name).not.toBe("");
  });
});

describe("executor", () => {
  const node = process.execPath;
  const cfg = async (
    name: string,
    transport: "command" | "mcp",
    script: string,
    extra: string[] = [],
  ): Promise<ExecutorConfig> => {
    const state = join(await mkdtemp(join(tmpdir(), "conf-exec-")), "state.json");
    return {
      name,
      transport,
      command: node,
      args: [script, "--transport", transport, "--state", state, ...extra],
      procedures: [],
      stepKinds: [],
      fillOnly: false,
      timeoutMs: 10_000,
      tools: {},
    };
  };

  for (const transport of ["command", "mcp"] as const)
    it(`golden: the reference executor conforms over ${transport}`, async () => {
      const config = await cfg(`ref-${transport}`, transport, REFERENCE_EXECUTOR);
      const r = await conformanceRun("(config)", { kind: "executor", config });
      expect(problems(r)).toEqual([]);
      // Over command the reference executor says it can fill without submitting; over MCP it
      // doesn't, so the fill-only case is skipped there.
      expect(passes(r)).toEqual([
        "executor.config",
        "executor.ping",
        "executor.idempotency-fresh",
        "executor.run",
        "executor.progress",
        "executor.idempotency-used",
        "executor.duplicate",
        ...(transport === "command" ? ["executor.fill-only", "executor.fill-only"] : []),
      ]);
    });

  it("golden: an executor that forgets idempotency keys", async () => {
    const config = await cfg("forgetful", "command", join(FIX, "executors/forgetful-executor.mjs"));
    const r = await conformanceRun("(config)", { kind: "executor", config });
    expect(problems(r)).toEqual([
      ["executor.progress", "warn", "", "Reported no progress before its result."],
      ["executor.idempotency-used", "fail", "", "Says a key already run is unused."],
      [
        "executor.duplicate",
        "fail",
        "",
        "The same write sent twice gave a different result: it ran twice.",
      ],
    ]);
  });

  it("reads executors.yaml and fails when the named executor isn't there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conf-execfile-"));
    const file = join(dir, "executors.yaml");
    await writeFile(
      file,
      `schemaVersion: 1\nexecutors:\n  - name: ref\n    transport: command\n    command: ${JSON.stringify(node)}\n    args: [${JSON.stringify(REFERENCE_EXECUTOR)}, --transport, command]\n`,
    );
    const missing = await conformanceRun(file, { kind: "executor", executor: "nope" });
    expect(problems(missing)).toEqual([["executor.config", "fail", "", "No executor named nope."]]);
    const r = await conformanceRun(file, { kind: "executor" });
    expect(r.results[0]).toMatchObject({
      check: "executor.config",
      status: "pass",
      message: "Executor ref over command.",
    });
    expect(r.results[1]).toMatchObject({ check: "executor.ping", status: "pass" });
  });
});
