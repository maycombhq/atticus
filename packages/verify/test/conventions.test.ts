import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Conventions, parseFacts, type Fact } from "@maycombhq/core";
import {
  dirSource,
  entriesNoFlowFollows,
  fileKinds,
  frameworkOf,
  frameworkTopics,
  frameworksToLearn,
  isDataFile,
  isSourceFile,
  memorySource,
  notReadForSkipped,
  planBatches,
  readRulesOf,
  verifyFacts,
} from "../src/index.js";

/**
 * ADR 0147: the lists verify had in its code are the org pack's conventions.yaml, with those
 * lists as defaults. One test per setting: the default reads as before, and an organisation's
 * own list changes what verify does.
 */
const conv = (o: Record<string, unknown>) => Conventions.parse({ schemaVersion: 1, ...o });
const bigJson = Array.from({ length: 2_100 }, (_, i) => `  "k${i}": ${i},`).join("\n");

describe("apiSpecFolders", () => {
  it("keeps a big spec in a folder the organisation names as code, and reads it for routes", () => {
    const path = "contracts/accounts.json";
    const lines = bigJson.split("\n");
    expect(isDataFile("openapi/accounts.json", lines)).toBe(false);
    expect(isDataFile(path, lines)).toBe(true);
    const rules = readRulesOf(conv({ apiSpecFolders: ["contracts"] }));
    expect(isDataFile(path, lines, rules)).toBe(false);
    expect(isDataFile("openapi/accounts.json", lines, rules)).toBe(true);
    // a spec's file carries the route and protocol rules only, where an unknown file carries all
    expect(fileKinds("contracts/accounts.yaml")).not.toEqual(["routes", "protocols"]);
    expect(fileKinds("contracts/accounts.yaml", rules)).toEqual(["routes", "protocols"]);
  });
});

describe("notProductFolders", () => {
  it("counts what the organisation says is product, and leaves out what it says isn't", () => {
    expect(isSourceFile("spec/Pricing.java")).toBe(false);
    expect(isSourceFile("qa/Pricing.java")).toBe(true);
    const rules = readRulesOf(conv({ notProductFolders: ["qa"] }));
    expect(isSourceFile("spec/Pricing.java", "", undefined, rules)).toBe(true);
    expect(isSourceFile("qa/Pricing.java", "", undefined, rules)).toBe(false);
    // the file-name rules (FooTest.java) are not folders and stay
    expect(isSourceFile("src/PricingTest.java", "", undefined, rules)).toBe(false);
  });

  it("is what verify's coverage and the batch plan count", async () => {
    const source = memorySource({
      "src/Pricing.java": "class Pricing {}\n",
      "spec/Rates.java": "class Rates {}\n",
    });
    const total = (c?: Conventions) =>
      verifyFacts({ facts: [], source, ...(c ? { conventions: c } : {}) }).then(
        (r) => r.coverage.unknown,
      );
    expect(await total()).toEqual(["src/Pricing.java"]);
    expect(await total(conv({ notProductFolders: [] }))).toEqual([
      "spec/Rates.java",
      "src/Pricing.java",
    ]);
    expect(
      planBatches(source, { room: 10_000, conventions: conv({ notProductFolders: [] }) }).files,
    ).toBe(2);
  });
});

describe("notReadFolders", () => {
  it("is where the skipped-lines note doesn't look", () => {
    expect(notReadForSkipped("gen/Client.java")).toBe(true);
    expect(notReadForSkipped("autogen/Client.java")).toBe(false);
    const rules = readRulesOf(conv({ notReadFolders: ["autogen"] }));
    expect(notReadForSkipped("gen/Client.java", rules)).toBe(false);
    expect(notReadForSkipped("autogen/Client.java", rules)).toBe(true);
  });
});

describe("gatewayBundleFolders", () => {
  const entry = (file: string): Fact =>
    ({
      kind: "entry",
      id: "entry.get.rates",
      repo: "forge-gateway",
      commit: "0123abc",
      verified: "none",
      by: "assistant",
      conf: "declared",
      entryType: "rest",
      method: "GET",
      path: "/rates",
      cite: { file, line: 3, value: "/rates" },
    }) as Fact;

  const forward = (from: string): Fact =>
    ({
      kind: "call",
      id: "call.get.rates.forward",
      repo: "forge-gateway",
      commit: "0123abc",
      verified: "none",
      by: "assistant",
      conf: "declared",
      callType: "rest",
      method: "GET",
      path: "/rates",
      from,
      cite: { file: "proxies/rates/apiproxy/targets/default.xml", line: 4, value: "/rates" },
    }) as Fact;

  it("asks a route in a bundle folder the organisation names for its forwarding call, not a flow", () => {
    const bundled = entry("proxies/rates/proxy-bundles/proxies/default.xml");
    expect(entriesNoFlowFollows([bundled])).toMatchObject([{ id: "entry.get.rates" }]);
    expect(entriesNoFlowFollows([bundled])[0]!.route).toBeUndefined();
    const rules = readRulesOf(conv({ gatewayBundleFolders: ["proxy-bundles"] }));
    // beta.19: a route with no forwarding call is asked for one; with it, nothing is asked.
    expect(entriesNoFlowFollows([bundled], rules)).toMatchObject([
      { id: "entry.get.rates", route: true },
    ]);
    expect(entriesNoFlowFollows([bundled, forward("entry.get.rates")], rules)).toEqual([]);
    const apigee = entry("proxies/rates/apiproxy/proxies/default.xml");
    expect(entriesNoFlowFollows([apigee])).toMatchObject([{ id: "entry.get.rates", route: true }]);
    expect(entriesNoFlowFollows([apigee, forward("entry.get.rates")])).toEqual([]);
  });
});

describe("frameworks (verify's framework table)", () => {
  const FIX = join(__dirname, "..", "..", "..", "fixtures", "frameworks");
  const COMMIT = "4f1d2a9c8b7e6f5a4d3c2b1a0978563412fedcba";
  const facts = (repo: string): Fact[] => {
    const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.facts;
  };
  const house = conv({
    frameworks: [
      {
        declares: "forge-card-starter",
        name: "forge-card-starter",
        topic: "house",
        shape: "batch-job",
      },
    ],
  });

  it("knows a house starter the organisation names, before the built-in table", () => {
    expect(frameworkOf("forge-card-starter")).toBeUndefined();
    expect(frameworkOf("forge-card-starter", house.frameworks)).toEqual({
      name: "forge-card-starter",
      topic: "house",
      shape: "batch-job",
    });
    // its own word for a known declaration wins, and a topic the protocol has no part for is dropped
    expect(
      frameworkOf("express", [{ declares: "express", name: "forge-express", topic: "nope" }]),
    ).toEqual({ name: "forge-express" });
  });

  it("turns on its rules, offers nothing to learn, and asks about its missing shape", async () => {
    const fs = facts("forge-cards-api");
    expect(frameworksToLearn(fs).map((l) => l.framework)).toEqual(["forge-card-starter"]);
    expect(frameworksToLearn(fs, [], house.frameworks)).toEqual([]);
    expect(frameworkTopics(fs, house.frameworks)).toContain("house");
    const source = dirSource(join(FIX, "repos", "forge-cards-api"));
    const plain = await verifyFacts({ facts: fs, source, commit: COMMIT });
    const own = await verifyFacts({ facts: fs, source, commit: COMMIT, conventions: house });
    expect(own.rejected).toEqual([]);
    expect(plain.frameworkGaps.map((g) => g.framework)).not.toContain("forge-card-starter");
    expect(own.frameworkGaps.map((g) => [g.framework, g.expected])).toContainEqual([
      "forge-card-starter",
      "batch-job",
    ]);
  });
});
