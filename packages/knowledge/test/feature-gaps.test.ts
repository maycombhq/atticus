import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CatalogRecord, RecordOf } from "@maycombhq/core";
import { coverage, FEATURE_CHECKS, KNOWLEDGE_CHECKS, knowledgeGaps } from "../src/index.js";
import { HERE, forgePack, forgeRecords, record } from "./helpers.js";

type Capability = RecordOf<"Capability">;

/** The hand-written Forge features (the features package's golden file), as records. */
const forgeFeatures = (): Capability[] =>
  (
    parse(
      readFileSync(join(HERE, "../../features/test/fixtures/forge-features.yaml"), "utf8"),
    ) as Record<string, unknown>[]
  ).map((r) => record(r) as Capability);

interface Expected {
  check: string;
  system: string;
  owner: string;
  records: string[];
  question: string;
  neededFact: string;
}
const expected = parse(
  readFileSync(join(HERE, "fixtures/forge-feature-gaps.yaml"), "utf8"),
) as Expected[];

const featureGaps = async (records: CatalogRecord[]) =>
  knowledgeGaps({ records, orgPack: await forgePack() }).filter((g) =>
    g.check.startsWith("feature-"),
  );

const withFeature = (id: string, patch: Record<string, unknown>) =>
  forgeFeatures().map((f) => (f.id === id ? (record({ ...f, ...patch }) as Capability) : f));

describe("feature knowledge gaps on Forge (golden)", () => {
  it("are registered after the built-in checks, each saying what it needs", () => {
    expect(FEATURE_CHECKS.map((c) => c.id)).toEqual([
      "feature-flow-complete",
      "feature-confirmed",
      "feature-work-item-linked",
      "feature-tested",
      "feature-monitored",
      "feature-described",
    ]);
    expect(KNOWLEDGE_CHECKS.slice(-6)).toEqual(FEATURE_CHECKS);
    for (const c of FEATURE_CHECKS) expect(c.needs.length).toBeGreaterThan(0);
  });

  it("raise exactly the hand-written owner questions", async () => {
    const gaps = await featureGaps([...forgeRecords(), ...forgeFeatures()]);
    expect(
      gaps.map((g) => ({
        check: g.check,
        system: g.system,
        owner: g.owner,
        records: g.records,
        question: g.question.question,
        neededFact: g.question.neededFact,
      })),
    ).toEqual(expected);
    // each is an OwnerQuestion with the feature's evidence
    const q = gaps[0]!.question;
    expect(q).toMatchObject({
      kind: "OwnerQuestion",
      id: "q.feature-flow-complete.feature.payments",
      confidence: "inferred",
      questionState: "sent",
    });
    expect(q.evidence).toEqual(forgeFeatures().find((f) => f.id === "feature.payments")!.evidence);
  });

  it("add nothing to a catalog without features (the seeded gaps stay d09-d11)", async () => {
    expect(await featureGaps(forgeRecords())).toEqual([]);
  });
});

describe("what closes a feature gap", () => {
  it("a person's name and owner, a linked work item and a wiki page, tests and alerts", async () => {
    const features = withFeature("feature.transfers", {
      name: "Money transfers",
      namedBy: "person",
      owner: "team-payments",
      confidence: "asserted",
      externalRefs: [
        { system: "ado", id: "102" },
        { system: "wiki", id: "wiki.example.com/pages/transfers" },
      ],
      evidence: [
        ...forgeFeatures().find((f) => f.id === "feature.transfers")!.evidence,
        { source: "manual", by: "a.owner" },
      ],
    });
    const tests = [
      record({
        kind: "QualityAsset",
        id: "reports-job.test-suite.ci",
        confidence: "verified",
        component: "reports-job",
        assetKind: "test-suite",
        details: { files: ["**/TEST-*.xml"] },
        evidence: [
          { source: "pipeline", repo: "forge-reports-job", path: "azure-pipelines.yml", line: 9 },
        ],
      }),
      // a test file that calls the endpoint covers it too
      record({
        kind: "Unresolved",
        id: "portal-bff.http-call.t1",
        confidence: "inferred",
        unresolvedKind: "http-call",
        raw: "POST /transfers",
        owner: "portal-bff",
        evidence: [
          {
            source: "code",
            repo: "forge-ledger",
            path: "src/test/java/forge/ledger/TransferTest.java",
            line: 12,
          },
        ],
      }),
    ];
    const gaps = (await featureGaps([...forgeRecords(), ...features, ...tests])).filter((g) =>
      g.records.includes("feature.transfers"),
    );
    // only the flow's loose end is left, and it goes to the feature's own owner
    expect(gaps.map((g) => [g.check, g.owner])).toEqual([
      ["feature-flow-complete", "team-payments"],
    ]);
    expect(gaps[0]!.question.question).toBe(
      "Where does Money transfers (feature.transfers) really start or end? Nothing Atticus found makes portal-bff call POST /transfers.",
    );
  });

  it("asks for the owner alone once the name is confirmed, and for code when only documents describe a feature", async () => {
    const named = withFeature("feature.payments", {
      namedBy: "person",
      confidence: "asserted",
      evidence: [
        ...forgeFeatures().find((f) => f.id === "feature.payments")!.evidence,
        { source: "manual", by: "a.owner" },
      ],
    });
    const fromDocs = record({
      kind: "Capability",
      id: "feature.statements",
      confidence: "inferred",
      name: "Monthly statements",
      namedBy: "ai",
      entryPoints: [],
      records: [],
      evidence: [
        {
          source: "document",
          path: "inputs/wiki/ledger-solution-spec.md",
          line: 3,
          side: "document",
        },
      ],
    });
    const gaps = await featureGaps([...forgeRecords(), ...named, fromDocs]);
    const of = (id: string, check: string) =>
      gaps.find((g) => g.records[0] === id && g.check === check)?.question.question;
    expect(of("feature.payments", "feature-confirmed")).toBe(
      "Who owns Payments (feature.payments)?",
    );
    expect(of("feature.statements", "feature-confirmed")).toBe(
      'What do people call the feature Atticus\'s naming agent called "Monthly statements" (feature.statements), and who owns it?',
    );
    expect(of("feature.statements", "feature-described")).toBe(
      "Which code implements Monthly statements (feature.statements)? Only documents describe it.",
    );
    // with no entry point there is no system: the platform owner takes the question
    expect(gaps.find((g) => g.records[0] === "feature.statements")!.owner).toBe("team-platform");
  });
});

describe("coverage of features", () => {
  it("counts features confirmed, detected only, and the components no feature covers", async () => {
    const op = await forgePack();
    const res = coverage({ records: [...forgeRecords(), ...forgeFeatures()], orgPack: op });
    expect(res.features).toEqual({
      confirmed: [],
      detectedOnly: [
        "feature.account-balance",
        "feature.daily-entries-report",
        "feature.payments",
        "feature.transfers",
      ],
      unknown: ["audit-svc"],
    });
    const confirmed = coverage({
      records: [
        ...forgeRecords(),
        ...withFeature("feature.transfers", {
          namedBy: "person",
          confidence: "asserted",
          evidence: [{ source: "manual", by: "a.owner" }],
        }),
      ],
      orgPack: op,
    });
    expect(confirmed.features.confirmed).toEqual(["feature.transfers"]);
    expect(confirmed.features.detectedOnly).toHaveLength(3);
  });
});
