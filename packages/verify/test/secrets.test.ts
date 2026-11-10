import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts } from "@maycombhq/core";
import { dirSource, liveSecretsIn, verifyFacts } from "../src/index.js";

/**
 * Beta.24: a config file that holds what looks like a live secret is said when the repo is
 * verified: its file, line and key, never its value (the facts never hold it either). A value
 * that says where the secret lives (`${VAR}`, `env:`, `vault:`), a flag, an empty value or a
 * placeholder (`changeme`, `<secret>`, `xxxx`) is none.
 */
describe("a live-looking secret in a config file", () => {
  it("finds the key and line in YAML, properties, JSON and env files, never the value", () => {
    expect(
      liveSecretsIn("src/main/resources/application.yml", [
        "northwind:",
        "  client-id: forge-wallets",
        "  client_secret: nwlive-Q7f3Kd92LmZx41Rt",
        "  api-key: ${NORTHWIND_KEY}",
        "  password: changeme",
        "  token: ''",
        "  token-url: https://auth.northwind.example/token",
      ]),
    ).toEqual([{ file: "src/main/resources/application.yml", line: 3, key: "client_secret" }]);
    expect(
      liveSecretsIn("config/app.properties", [
        "# db",
        "db.password=s3cr3t-Pa55word",
        "db.user=forge",
        "vendor.api_key = <your key>",
      ]),
    ).toEqual([{ file: "config/app.properties", line: 2, key: "db.password" }]);
    expect(
      liveSecretsIn("config/settings.json", [
        "{",
        '  "apiSecret": "9f2c7e1a4b8d3c6e",',
        '  "apiSecretRef": "vault:kv/forge/api",',
        '  "accessToken": "xxxxxxxx"',
        "}",
      ]),
    ).toEqual([{ file: "config/settings.json", line: 2, key: "apiSecret" }]);
  });

  it("reads only config files: code is the readers', not this check's", () => {
    expect(liveSecretsIn("src/Client.java", ['String password = "s3cr3t-Pa55word";'])).toEqual([]);
  });

  it("is on the verifier's report for the vendor-proxy fixture's wallets service", async () => {
    const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-proxy");
    const parsed = parseFacts(readFileSync(join(FIX, "facts", "forge-wallets.jsonl"), "utf8"));
    if (!parsed.ok) throw new Error("facts don't parse");
    const r = await verifyFacts({
      facts: parsed.facts,
      source: dirSource(join(FIX, "repos", "forge-wallets")),
      commit: "9999bbb",
    });
    expect(r.secrets).toEqual([
      {
        file: "src/main/resources/application-forge-wallets-prod.yml",
        line: 10,
        key: "client_secret",
      },
    ]);
    expect(JSON.stringify(r)).not.toContain("nwlive-Q7f3Kd92LmZx41Rt");
  });
});
