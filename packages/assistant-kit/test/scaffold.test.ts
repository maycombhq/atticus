import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { scaffoldDialect, surveyRepos } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge/repos");
const golden = (name: string) => readFileSync(join(HERE, "golden", name), "utf8");

describe("surveyRepos", () => {
  it("finds the marker, layout, framework annotations, descriptor keys and config keys", async () => {
    const s = await surveyRepos([join(FORGE, "forge-ledger"), join(FORGE, "forge-reports-job")]);
    expect(s.repos).toEqual(["forge-ledger", "forge-reports-job"]);
    expect(s.markerCandidates).toEqual([{ path: "forge.yaml", repos: 1 }]);
    expect(s.marker).toBeUndefined();
    expect(s.sourceRoots).toEqual(["src/main/java"]);
    expect(s.configFiles).toEqual(["src/main/resources/application.yml"]);
    expect(s.descriptor).toBeUndefined();
    expect(s.annotations.map((a) => [a.name, a.known, a.targets, a.count, a.repos])).toEqual([
      ["ForgeCall", false, ["method"], 1, ["forge-ledger"]],
      ["ForgeClient", false, ["class"], 1, ["forge-ledger"]],
      ["ForgeEndpoint", false, ["method"], 2, ["forge-ledger"]],
      ["ForgePublish", false, ["method"], 1, ["forge-ledger"]],
      ["ForgeService", false, ["class"], 1, ["forge-ledger"]],
      ["ForgeSubscribe", false, ["method"], 1, ["forge-ledger"]],
      ["KafkaListener", true, ["method"], 1, ["forge-reports-job"]],
    ]);
    const call = s.annotations.find((a) => a.name === "ForgeCall")!;
    expect(call.attributes).toEqual(["method", "path"]);
    expect(call.enclosing).toEqual(["ForgeClient"]);
    expect(call.sample).toEqual({
      repo: "forge-ledger",
      path: "src/main/java/forge/ledger/NorthwindClient.java",
      line: 8,
      text: '@ForgeCall(method = "POST", path = "/v2/payments")',
    });
    expect(s.configKeys).toEqual([
      {
        key: "northwind.url",
        values: [{ repo: "forge-ledger", value: "https://api.northwind.example" }],
      },
      {
        key: "spring.datasource.url",
        values: [
          {
            repo: "forge-reports-job",
            value: "jdbc:postgresql://ledger-db.forge.internal:5432/ledger",
          },
        ],
      },
    ]);
  });

  it("reads the descriptor's keys when every repo has it", async () => {
    const s = await surveyRepos([join(FORGE, "forge-ledger")]);
    expect(s.marker).toBe("forge.yaml");
    expect(s.descriptor).toEqual({
      file: "forge.yaml",
      nameKey: "service",
      keys: [
        { key: "framework", values: [{ repo: "forge-ledger", value: "forge" }] },
        { key: "service", values: [{ repo: "forge-ledger", value: "ledger-api" }] },
        { key: "system", values: [{ repo: "forge-ledger", value: "ledger" }] },
      ],
    });
  });

  it("is deterministic whatever order the repos are given in", async () => {
    const a = await surveyRepos([join(FORGE, "forge-ledger"), join(FORGE, "forge-reports-job")]);
    const b = await surveyRepos([join(FORGE, "forge-reports-job"), join(FORGE, "forge-ledger")]);
    expect(b).toEqual(a);
  });
});

describe("scaffoldDialect", () => {
  it("writes the golden scaffold for forge-ledger", async () => {
    const text = scaffoldDialect("forge-house", await surveyRepos([join(FORGE, "forge-ledger")]));
    expect(text).toBe(golden("forge-ledger.yaml.golden"));
  });

  it("writes the golden scaffold for two repos with no common marker", async () => {
    const text = scaffoldDialect(
      "forge-house",
      await surveyRepos([join(FORGE, "forge-ledger"), join(FORGE, "forge-reports-job")]),
    );
    expect(text).toBe(golden("forge-ledger-reports.yaml.golden"));
  });

  it("is valid YAML with empty rules and tests, and uncommenting a candidate gives a rule", async () => {
    const text = scaffoldDialect("forge-house", await surveyRepos([join(FORGE, "forge-ledger")]));
    const doc = parse(text) as Record<string, unknown>;
    expect(doc).toMatchObject({
      schemaVersion: 1,
      name: "forge-house",
      appliesTo: { marker: "forge.yaml" },
      rules: [],
      tests: [],
    });
    // Uncomment the first candidate (its lines up to the next blank comment) and drop the [].
    const lines = text.split("\n");
    const start = lines.indexOf("  # - id: forge-call");
    let end = start;
    while (lines[end + 1] !== "  #") end++;
    const edited = [
      ...lines.slice(0, start),
      ...lines.slice(start, end + 1).map((l) => l.replace(/^ {2}# /, "  ")),
      ...lines.slice(end + 1).filter((l) => l !== "  []"),
    ].join("\n");
    const rule = (parse(edited) as { rules: Record<string, unknown>[] }).rules[0];
    expect(rule).toMatchObject({
      id: "forge-call",
      match: { annotation: "ForgeCall", target: "method", files: ["src/main/java/**/*.java"] },
      emit: { kind: "TODO", id: "${yaml:forge.yaml#service}.TODO" },
      confidence: "inferred",
    });
  });
});
