import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  joinFacts,
  joinRecords,
  normalizeFactPaths,
  parseCorrections,
  parseFactLine,
  parseFacts,
  parseFactsLines,
  serializeFacts,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * A facts line written on Windows (a Copilot session, say) can cite `src\main\...`. Every file
 * path a facts line carries is read with `/` (ADR 0124 addendum W-paths): the cite's file, each
 * `cite.with` part's, an auth's and a scope's and a caller's, so the verifier, the join's folder
 * and bundle rules and every record downstream see one form, whichever OS wrote the line.
 */

const ROOT = join(__dirname, "..", "..", "..", "fixtures");
/** A facts file's text with every `file` written the Windows way. */
const backslashed = (text: string) =>
  text.replace(
    /"file":"([^"]*)"/g,
    (_, f: string) => `"file":${JSON.stringify(f.replace(/\//g, "\\"))}`,
  );

const ENTRY = {
  kind: "entry",
  id: "e-get-limit",
  repo: "forge-limits",
  commit: "8888ccc",
  entryType: "rest",
  method: "GET",
  path: "/limits/{id}",
  cite: {
    file: "src\\main\\java\\forge\\limits\\LimitsController.java",
    line: 20,
    value: "/limits/{id}",
    with: [{ file: "src\\main\\java\\forge\\limits\\Base.java", line: 3, value: "/limits" }],
  },
  authCite: { file: "src\\main\\java\\forge\\Security.java", line: 9, value: "oauth2" },
  scopes: [{ file: "src\\main\\java\\forge\\Security.java", line: 10, value: "limits.read" }],
  callers: [{ file: "deploy\\policy.yaml", line: 4, value: "forge-web", as: "app" }],
  verified: "line",
  by: "assistant",
  conf: "declared",
};
const FORWARD = {
  cite: {
    file: "src/main/java/forge/limits/LimitsController.java",
    with: [{ file: "src/main/java/forge/limits/Base.java" }],
  },
  authCite: { file: "src/main/java/forge/Security.java" },
  scopes: [{ file: "src/main/java/forge/Security.java" }],
  callers: [{ file: "deploy/policy.yaml" }],
};

describe("facts: a path written with backslashes is read with / (W-paths)", () => {
  it("normalises every file path of a line, and nothing else", () => {
    expect(normalizeFactPaths(ENTRY)).toMatchObject(FORWARD);
    // a path the fact claims (an HTTP path, a key) is never a file: left as written
    expect(normalizeFactPaths({ ...ENTRY, path: "/a\\b" })).toMatchObject({ path: "/a\\b" });
  });

  it("reads them so in each way a facts file is read", () => {
    const line = JSON.stringify(ENTRY);
    const a = parseFacts(line);
    if (!a.ok) throw new Error(JSON.stringify(a.issues));
    expect(a.facts[0]).toMatchObject(FORWARD);
    const b = parseFacts(`[${line}]`);
    if (!b.ok) throw new Error(JSON.stringify(b.issues));
    expect(b.facts[0]).toMatchObject(FORWARD);
    expect(parseFactLine(line, 1, new Set()).fact).toMatchObject(FORWARD);
    expect(parseFactsLines(line).facts[0]).toMatchObject(FORWARD);
    // and written back with / only
    expect(serializeFacts(a.facts)).not.toContain("\\\\");
  });

  it("reads a correction's target file with /, so it meets the fact it is about", () => {
    const r = parseCorrections(
      JSON.stringify({
        schemaVersion: 1,
        fact: "e-get-limit",
        target: {
          kind: "entry",
          file: "src\\main\\java\\forge\\limits\\LimitsController.java",
          line: 20,
          value: "/limits/{id}",
        },
        action: "wrong",
        reason: "not an entry",
        by: "Forge Dev",
        at: "2026-10-01T10:00:00Z",
      }),
    );
    expect(r.bad).toEqual([]);
    expect(r.corrections[0]!.target.file).toBe("src/main/java/forge/limits/LimitsController.java");
  });
});

describe("the join reads backslash cites exactly as forward-slash ones (J0, A-gateway)", () => {
  const read = (file: string, slash: "/" | "\\"): Fact[] => {
    const text = readFileSync(file, "utf8");
    const r = parseFacts(slash === "/" ? text : backslashed(text));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.facts;
  };

  it("resolves a placeholder through a setting in a folder named for the component", () => {
    const dir = join(ROOT, "estate-facts", "placeholders");
    const estate = (slash: "/" | "\\"): JoinRepo[] => [
      { repo: "forge-pay", component: "pay-api", facts: read(join(dir, "forge-pay.jsonl"), slash) },
      { repo: "forge-config", facts: read(join(dir, "forge-config.jsonl"), slash) },
      {
        repo: "forge-payments",
        component: "payments-api",
        hosts: ["apps.ocp.forge.internal"],
        basePath: "/forge/payments",
        facts: read(join(dir, "forge-payments.jsonl"), slash),
      },
      {
        repo: "forge-ledger",
        component: "ledger-api",
        hosts: ["ledger.forge.internal"],
        facts: read(join(dir, "forge-ledger.jsonl"), slash),
      },
    ];
    expect(backslashed(readFileSync(join(dir, "forge-config.jsonl"), "utf8"))).toContain(
      "apps\\\\pay-api",
    );
    const fwd = joinFacts({ repos: estate("/") });
    const back = joinFacts({ repos: estate("\\") });
    expect(back).toEqual(fwd);
    expect(back.joins.some((j) => j.call.fact === "c-post-payment")).toBe(true);
    expect(joinRecords(back, estate("\\"))).toEqual(joinRecords(fwd, estate("/")));
  });

  it("follows an Apigee bundle's routes, its folders written with backslashes", () => {
    const dir = join(ROOT, "gateway-facts", "facts");
    // No repo typed `gateway`: only the bundle folder (`apiproxy/`) in the cite says it is one.
    const estate = (slash: "/" | "\\"): JoinRepo[] => [
      {
        repo: "forge-portal-api",
        component: "portal-api",
        facts: read(join(dir, "forge-portal-api.jsonl"), slash),
      },
      {
        repo: "forge-gateway",
        component: "api-gateway",
        hosts: ["api.forge.example"],
        facts: read(join(dir, "forge-gateway.jsonl"), slash),
      },
      {
        repo: "forge-accounts",
        component: "accounts-api",
        hosts: ["accounts.forge.internal"],
        facts: read(join(dir, "forge-accounts.jsonl"), slash),
      },
    ];
    const fwd = joinFacts({ repos: estate("/") });
    expect(fwd.joins.some((j) => j.gateway?.length)).toBe(true);
    expect(joinFacts({ repos: estate("\\") })).toEqual(fwd);
  });
});
