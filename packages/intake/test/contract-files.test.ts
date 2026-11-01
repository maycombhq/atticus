import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readConsumerOpenApi, readContractFiles, readPactFile } from "../src/index.js";

/**
 * J3 (ADR 0151): the contract files a consumer keeps, read as text and JSON in any language's
 * repo: Pact files (spec v2, v3, v4) and the OpenAPI specs of the APIs it calls. The golden is
 * what `atticus verify forge-portal-api --write` stores beside its facts.
 */

const FX = join(__dirname, "..", "..", "..", "fixtures", "link-evidence");
const REPO = join(FX, "forge-portal-api");
const text = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("readPactFile", () => {
  it("reads a v3 file's requests, each at the line of its path", () => {
    expect(
      readPactFile(text("pacts/forge-portal-api-forge-accounts.json"), "pacts/a.json"),
    ).toEqual([
      {
        format: "pact",
        file: "pacts/a.json",
        line: 10,
        consumer: "forge-portal-api",
        provider: "forge-accounts",
        method: "GET",
        path: "/forge/v1/accounts/{id}",
      },
      {
        format: "pact",
        file: "pacts/a.json",
        line: 22,
        consumer: "forge-portal-api",
        provider: "forge-accounts",
        method: "DELETE",
        path: "/forge/v1/accounts/{id}",
      },
    ]);
  });

  it("reads a v4 file's HTTP interactions and skips its messages", () => {
    const got = readPactFile(text("pacts/forge-portal-api-forge-ledger.json"), "p.json")!;
    expect(got.map((e) => [e.method, e.path, e.line])).toEqual([
      ["POST", "/forge/v1/accounts/{id}/transfers", 10],
    ]);
  });

  it("is not a Pact file without a consumer, a provider and interactions", () => {
    expect(
      readPactFile(`{"name": "forge-web", "version": "1.0.0"}`, "package.json"),
    ).toBeUndefined();
    expect(readPactFile("not json at all {", "x.json")).toBeUndefined();
  });
});

describe("readConsumerOpenApi", () => {
  it("reads a spec the consumer keeps, its title and server hosts naming the provider", () => {
    const got = readConsumerOpenApi(text("clients/accounts-openapi.yaml"), "c.yaml", [])!;
    expect(got.map((e) => [e.method, e.path, e.line, e.provider, e.hosts])).toEqual([
      [
        "GET",
        "/forge/v1/accounts/{id}",
        9,
        "forge-accounts",
        ["https://api.forge.example/forge/v1"],
      ],
      [
        "GET",
        "/forge/v1/accounts/{id}/statements",
        15,
        "forge-accounts",
        ["https://api.forge.example/forge/v1"],
      ],
    ]);
  });

  it("leaves out a repo's own spec: one its own entries serve", () => {
    expect(
      readConsumerOpenApi(text("clients/accounts-openapi.yaml"), "c.yaml", [
        { method: "GET", path: "/forge/v1/accounts/{accountId}" },
      ]),
    ).toEqual([]);
  });
});

describe("readContractFiles", () => {
  it("finds every contract file in a checkout and gives the golden companion", async () => {
    const got = await readContractFiles(REPO, { repo: "forge-portal-api", commit: "8888bbb" });
    expect(got).toEqual(
      parse(readFileSync(join(FX, "expected", "forge-portal-api.contracts.yaml"), "utf8")),
    );
  });
});

describe("readContractFiles: no id, token, credential or denied word from a contract file", () => {
  const LEAKY = join(FX, "forge-leaky-client");
  const deny = new Set([createHash("sha256").update("tidewater", "utf8").digest("hex")]);

  it("cuts query strings, fragments and matrix params, templates ids, drops URL credentials", async () => {
    const notes: string[] = [];
    const got = await readContractFiles(LEAKY, {
      repo: "forge-leaky-client",
      denyHashes: deny,
      onRefused: (n) => notes.push(n),
    });
    // The note names the file (to the person running the write, never into a file).
    const all = JSON.stringify(got) + notes.join("\n").replace(/pacts\/[\w.-]+\.json/g, "");
    for (const s of [
      "ACC-1001",
      "token",
      "abc123secretvalue",
      "abcdefghijklmnopqrstuvwxyz",
      "ABCDEFGHIJKLMNOPQRSTU",
      "jsessionid",
      "frag",
      "svcuser",
      "hunter2pass",
      "s3cr3tkey99",
      "key=",
      "tidewater",
      "/ledger/entries",
    ])
      expect(all).not.toContain(s);
    expect(got.entries.map((e) => [e.format, e.method, e.path, e.hosts])).toEqual([
      ["openapi", "GET", "/invoices/{invoiceId}", ["https://billing.forge.example/api/v2"]],
      ["pact", "GET", "/forge/v1/accounts/{id}", undefined],
      ["pact", "GET", "/forge/v1/sessions/{id}/items", undefined],
    ]);
    expect(notes).toEqual([
      "pacts/forge-leaky-client-tidewater-ledger.json: the deny-list names a word in it, so its requests are left out.",
    ]);
  });
});
