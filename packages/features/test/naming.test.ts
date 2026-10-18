import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime, ReplayRuntime } from "@maycombhq/ai";
import {
  detectFeatures,
  featureNamerAgent,
  featuresForScan,
  nameFeatures,
  readNameProposals,
  writeNameProposals,
  type Capability,
} from "../src/index.js";
import { FIX, forgeRecords } from "./helpers.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const features = () => detectFeatures(forgeRecords());

/** What a model might answer: two good proposals and three that must be thrown away. */
const ANSWER = `features:
  - id: feature.transfers
    name: Money transfers
    description: Moves money between accounts through the ledger and tells reporting when a transfer completes.
    tags: [Payments, ledger]
    evidence: [ledger-api.post-transfer, topic.transfers-completed]
  - id: feature.account-balance
    name: Account balance
    description: Shows a customer the balance of an account, read from the ledger.
    tags: [accounts]
    evidence: [portal-bff.get-balance, made-up-service]
  - id: feature.payments
    name: Card payments
    evidence: [northwind-ledger-bridge]
  - id: feature.refunds
    name: Refunds
    evidence: [ledger-api]
  - id: feature.daily-entries-report
    description: no name given
    evidence: [reports-job]
`;

describe("nameFeatures", () => {
  it("proposes names from evidence, wrapped as data, and keeps only proposals that cite the feature", async () => {
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req) => {
        prompts.push(req.pack.prompt);
        return ANSWER;
      },
      { now: () => NOW },
    );
    const res = await nameFeatures(features(), forgeRecords(), runtime, { now: NOW });
    expect(res.runs.map((r) => [r.agent, r.state, r.features])).toEqual([
      [
        "feature-namer",
        "ran",
        [
          "feature.account-balance",
          "feature.daily-entries-report",
          "feature.payments",
          "feature.transfers",
        ],
      ],
    ]);
    expect(res.proposals).toEqual([
      {
        feature: "feature.transfers",
        name: "Money transfers",
        description:
          "Moves money between accounts through the ledger and tells reporting when a transfer completes.",
        tags: ["payments", "ledger"],
        evidence: ["ledger-api.post-transfer", "topic.transfers-completed"],
        agent: "feature-namer",
        at: "2026-10-18T12:00:00Z",
        runId: res.runs[0]!.summary!.runId,
      },
      {
        feature: "feature.account-balance",
        name: "Account balance",
        description: "Shows a customer the balance of an account, read from the ledger.",
        tags: ["accounts"],
        evidence: ["portal-bff.get-balance"],
        agent: "feature-namer",
        at: "2026-10-18T12:00:00Z",
        runId: res.runs[0]!.summary!.runId,
      },
    ]);
    expect(res.discarded).toEqual([
      { feature: "feature.payments", reason: "it cites no record id from the feature's evidence" },
      {
        feature: "feature.refunds",
        reason: "feature.refunds isn't one of the features it was given",
      },
      {
        feature: "feature.daily-entries-report",
        reason: "not a proposal: name Invalid input: expected string, received undefined",
      },
    ]);
    // the instructions come first and are trusted; every feature is a data block
    const prompt = prompts[0]!;
    expect(prompt.indexOf("# Feature namer")).toBeLessThan(prompt.indexOf("<atticus-data id="));
    expect(prompt).toContain('<atticus-data id="feature.transfers" kind="catalog"');
    expect(prompt).toContain("POST /transfers on ledger-api");
    expect(prompt).toContain("forge-ledger:src/main/java/forge/ledger/LedgerEndpoints.java:11");
  });

  it("leaves features a person named alone", async () => {
    const named = features().map((f) =>
      f.id === "feature.transfers" ? ({ ...f, namedBy: "person" } as Capability) : f,
    );
    let asked: string[] = [];
    const runtime = new MockRuntime((req) => {
      asked = req.pack.manifest.sources.filter((s) => !s.trusted).map((s) => s.id);
      return "features: []";
    });
    await nameFeatures(named, forgeRecords(), runtime, { now: NOW });
    expect(asked).toEqual([
      "feature.account-balance",
      "feature.daily-entries-report",
      "feature.payments",
    ]);
  });

  it("reports output that isn't YAML, and a run that fails, without proposing anything", async () => {
    const bad = await nameFeatures(
      features(),
      forgeRecords(),
      new MockRuntime(() => "features: [unclosed"),
      {
        now: NOW,
      },
    );
    expect(bad.proposals).toEqual([]);
    expect(bad.discarded[0]!.reason).toMatch(/^the output is not YAML/);
    const empty = await nameFeatures(features(), forgeRecords(), new ReplayRuntime([]), {
      now: NOW,
    });
    expect(empty.runs[0]).toMatchObject({ state: "failed" });
    expect(empty.runs[0]!.reason).toMatch(
      /^no recording for agent feature-namer with prompt [0-9a-f]{64}/,
    );
  });

  it("replays a hand-written recording (no live model in tests)", async () => {
    const runtime = await ReplayRuntime.fromDir(join(FIX, "recordings"), { now: () => NOW });
    const res = await nameFeatures(features(), forgeRecords(), runtime, { now: NOW });
    expect(res.runs[0]).toMatchObject({ state: "ran" });
    expect(res.proposals.map((p) => [p.feature, p.name, p.tags])).toEqual([
      ["feature.account-balance", "Account balance", ["accounts"]],
      ["feature.daily-entries-report", "Daily ledger entries report", ["reporting"]],
      ["feature.payments", "Vendor payments", ["payments"]],
      ["feature.transfers", "Money transfers", ["payments"]],
    ]);
    expect(res.discarded).toEqual([]);
  });

  it("uses the org pack's feature-namer agent when there is one, else a built-in default", () => {
    const def = featureNamerAgent();
    expect(def).toMatchObject({
      id: "feature-namer",
      role: "architect",
      inputs: ["catalog-slice"],
    });
    const own = { ...def, description: "Our own namer.", tokenBudget: 9000 };
    expect(
      featureNamerAgent({
        agents: [own],
        runtime: { budgets: { defaultTokens: 1, perAgent: {} } } as never,
      }).description,
    ).toBe("Our own namer.");
  });
});

describe("name proposals on disk", () => {
  it("are written one file per feature, read back, and name features in every scan, still inferred", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-proposals-"));
    const written = await writeNameProposals(dir, [
      {
        feature: "feature.payments",
        name: "Vendor payments",
        tags: ["payments"],
        evidence: ["if-e7344c9455608119"],
        agent: "feature-namer",
        at: "2026-10-18T12:00:00Z",
      },
    ]);
    expect(written).toEqual(["capability/feature.payments.yaml"]);
    expect(await readFile(join(dir, "capability/feature.payments.yaml"), "utf8")).toBe(
      [
        "schemaVersion: 1",
        "feature: feature.payments",
        "name: Vendor payments",
        "tags:",
        "  - payments",
        "evidence:",
        "  - if-e7344c9455608119",
        "agent: feature-namer",
        "at: 2026-10-18T12:00:00Z",
        "",
      ].join("\n"),
    );
    await mkdir(join(dir, "capability"), { recursive: true });
    await writeFile(join(dir, "capability/broken.yaml"), "feature: feature.x\n");
    const back = await readNameProposals(dir);
    expect(back.proposals.map((p) => p.feature)).toEqual(["feature.payments"]);
    expect(back.problems).toEqual([
      { file: "capability/broken.yaml", message: expect.stringContaining("schemaVersion") },
    ]);
    const scan = await featuresForScan({
      records: forgeRecords(),
      decisions: [],
      proposalsDir: dir,
    });
    expect(scan.features.find((f) => f.id === "feature.payments")).toMatchObject({
      name: "Vendor payments",
      namedBy: "ai",
      confidence: "inferred",
    });
    expect(scan.problems.map((p) => p.decision)).toEqual(["proposals/capability/broken.yaml"]);
  });
});
