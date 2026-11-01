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
        path: "/forge/v1/accounts/ACC-1001",
      },
      {
        format: "pact",
        file: "pacts/a.json",
        line: 22,
        consumer: "forge-portal-api",
        provider: "forge-accounts",
        method: "DELETE",
        path: "/forge/v1/accounts/ACC-1001",
      },
    ]);
  });

  it("reads a v4 file's HTTP interactions and skips its messages", () => {
    const got = readPactFile(text("pacts/forge-portal-api-forge-ledger.json"), "p.json")!;
    expect(got.map((e) => [e.method, e.path, e.line])).toEqual([
      ["POST", "/forge/v1/accounts/ACC-1001/transfers", 10],
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
