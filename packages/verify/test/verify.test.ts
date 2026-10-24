import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, memorySource, verifyFacts } from "../src/index.js";

const fixtures = join(__dirname, "fixtures");
const repo = join(fixtures, "repo");
const load = (name: string): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, name), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

describe("verifyFacts: the claim on the cited line (ADR 0124)", () => {
  it("accepts every fact of a correct read, and marks each verified by the line check", async () => {
    const facts = load("forge-ledger.facts.jsonl");
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(17);
    for (const f of r.accepted) expect(f.verified).toBe("line");
  });

  it("rejects every fabricated or misplaced citation in the red-team file, each with its reason", async () => {
    const facts = [...load("forge-ledger.facts.jsonl"), ...load("redteam.facts.jsonl")];
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    const why = Object.fromEntries(r.rejected.map((x) => [x.fact.id, x.code]));
    expect(why).toEqual({
      "rt-no-file": "no-file",
      "rt-past-end": "no-line",
      "rt-wrong-line": "claim-not-on-line",
      "rt-invented-path": "claim-not-on-line",
      "rt-invented-table": "claim-not-on-line",
      "rt-invented-field": "claim-not-on-line",
      "rt-quote-mismatch": "quote-mismatch",
      "rt-dangling": "dangling-ref",
      "rt-secret-path": "secret-path",
      "rt-wrong-commit": "wrong-commit",
      "rt-traversal": "outside-repo",
    });
    expect(r.accepted).toHaveLength(17);
    for (const x of r.rejected) expect(x.message.length).toBeGreaterThan(10);
  });

  it("a fact that names a rejected fact is rejected too", async () => {
    const facts = load("forge-ledger.facts.jsonl").map((f) =>
      f.id === "e-post-entry" ? { ...f, cite: { ...f.cite, line: 3 } } : f,
    );
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    const ids = r.rejected.map((x) => `${x.fact.id}:${x.code}`).sort();
    expect(ids).toEqual(
      [
        "e-post-entry:claim-not-on-line",
        "f-entry-amount:ref-rejected",
        "f-entry-currency:ref-rejected",
        "w-post-entry:ref-rejected",
        "c-fx-rate:ref-rejected",
        "c-notify:ref-rejected",
        "s-entry-write:ref-rejected",
        "f-col-amount:ref-rejected",
        "f-col-account-id:ref-rejected",
        "f-fx-pair:ref-rejected",
      ].sort(),
    );
  });

  it("forgives the model's small rewrites of a quote, and needs none from a minified line", async () => {
    const facts = load("forge-ledger.facts.jsonl").map((f) =>
      f.id === "c-fx-rate"
        ? {
            ...f,
            cite: {
              ...f.cite,
              quote: "return rest.getForObject(base + '/v1/rates/' + pair, Rate.class).",
            },
          }
        : f,
    );
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    expect(r.rejected).toEqual([]);
    const min = memorySource({ "dist/app.min.js": `${"x".repeat(1200)}fetch("/api/v2/orders")` });
    const one = await verifyFacts({
      source: min,
      facts: [
        {
          kind: "call",
          id: "c-min",
          repo: "web",
          commit: "0123abc",
          callType: "rest",
          method: "GET",
          path: "/api/v2/orders",
          to: "orders",
          cite: {
            file: "dist/app.min.js",
            line: 1,
            value: "/api/v2/orders",
            quote: "no such text",
          },
          verified: "none",
          by: "assistant",
          conf: "declared",
        },
      ],
    });
    expect(one.rejected).toEqual([]);
  });

  it("redacts a secret value in a stored quote and never keeps a value as a fact", async () => {
    const src = memorySource({ "config/app.yml": "db:\n  password: s3cr3t\n" });
    const r = await verifyFacts({
      source: src,
      facts: [
        {
          kind: "config",
          id: "k-pw",
          repo: "x",
          commit: "0123abc",
          settingKind: "config",
          key: "db.password",
          source: "config/app.yml",
          cite: { file: "config/app.yml", line: 2, value: "password", quote: "password: s3cr3t" },
          verified: "none",
          by: "assistant",
          conf: "declared",
        },
      ],
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0]!.cite.quote).toBe("password: <redacted>");
    expect(r.redacted).toBe(1);
  });

  it("keeps a person's verification stronger than the line check", async () => {
    const facts = load("forge-ledger.facts.jsonl").map((f) =>
      f.id === "d-prod" ? { ...f, verified: "person" as const } : f,
    );
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    expect(r.accepted.find((f) => f.id === "d-prod")!.verified).toBe("person");
  });
});

describe("coverage: reported, never trusted (ADR 0124)", () => {
  it("counts cited and routed files as read, the rest unknown; excludes generated code and secrets", async () => {
    const facts = load("forge-ledger.facts.jsonl");
    const r = await verifyFacts({
      facts,
      source: dirSource(repo),
      commit: "0123abc",
      routed: ["src/main/java/forge/ledger/SettlementListener.java"],
      exclude: ["generated/**"],
    });
    expect(r.coverage.read).toEqual(
      [
        "k8s/ledger-api.yaml",
        "src/main/java/forge/ledger/AccountController.java",
        "src/main/java/forge/ledger/AccountRepository.java",
        "src/main/java/forge/ledger/EntryController.java",
        "src/main/java/forge/ledger/EntryRepository.java",
        "src/main/java/forge/ledger/EntryRequest.java",
        "src/main/java/forge/ledger/FxClient.java",
        "src/main/java/forge/ledger/Notifier.java",
        "src/main/java/forge/ledger/SettlementListener.java",
        "src/main/resources/application.yml",
        "src/main/resources/db/migration/V2__create_entry.sql",
      ].sort(),
    );
    expect(r.coverage.unknown).toEqual([]);
    expect(r.coverage.excluded).toEqual(["generated/client.ts"]);
    expect(r.coverage.ratio).toBe(1);
    const partial = await verifyFacts({
      facts: facts.filter((f) => f.cite.file !== "k8s/ledger-api.yaml"),
      source: dirSource(repo),
      commit: "0123abc",
    });
    expect(partial.coverage.unknown).toContain("k8s/ledger-api.yaml");
    expect(partial.coverage.unknown).toContain("generated/client.ts");
    expect(partial.coverage.ratio).toBeLessThan(1);
  });

  it("is deterministic: the same input gives the same report", async () => {
    const facts = load("forge-ledger.facts.jsonl");
    const a = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    const b = await verifyFacts({
      facts: [...facts].reverse(),
      source: dirSource(repo),
      commit: "0123abc",
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
