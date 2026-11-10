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
  it("finds the key and line in YAML, properties and JSON files, never the value", () => {
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

describe("a live-looking secret: the review's cases (beta.24 review)", () => {
  const SECRET_VALUES = [
    "sk_live_abcdef1234567890",
    "Hunter2-live-99",
    "AKIAIOSFODNN7EXAMPLE",
    "Pa55w0rdLive",
    "eyJhbGciOiJIUzI1NiJ9",
    "MavenLive99x",
    "nwlive-Q7f3Kd92LmZx41Rt",
    "Live99web",
  ];
  const FILES: Record<string, string> = {
    "src/main/java/forge/Client.java": "class Client {}\n",
    ".env": "# local\nSTRIPE_API_KEY=sk_live_abcdef1234567890\nLOG_LEVEL=debug\n",
    ".env.production": "export DB_PASSWORD=Hunter2-live-99\n",
    "config/credentials.yml": "db:\n  password: Hunter2-live-99\n",
    "src/main/resources/application.yml": [
      "aws_access_key_id: AKIAIOSFODNN7EXAMPLE",
      "spring.datasource.url: jdbc:postgresql://forge:Pa55w0rdLive@db.forge.example/forge",
      "server.ssl.key-store-password: {cipher}AQBx9f3",
      "jwt.private-key: classpath:keys/jwt.pem",
      "oauth.token-endpoint: /auth/login",
      "password-policy: strong",
      "api-key: /etc/forge/api.key",
      "auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmn",
      "signing.private_key: keys/jwt.pem",
      "trust.secret: file:/etc/forge/trust.secret",
      "forge.token: ./local/token.txt",
    ].join("\n"),
    "src/main/resources/settings.xml":
      "<settings>\n  <password>MavenLive99x</password>\n</settings>\n",
    "web.config": [
      "<configuration>",
      '  <connectionStrings><add name="Forge" connectionString="Server=db;User Id=forge;Password=Live99web;" /></connectionStrings>',
      '  <appSettings><add key="NorthwindApiKey" value="nwlive-Q7f3Kd92LmZx41Rt" /></appSettings>',
      "</configuration>",
    ].join("\n"),
  };
  const src = { list: () => Object.keys(FILES), read: (p: string) => FILES[p] };

  it("scans env, credentials and secrets files for the report, by key and line, never the value (s2)", async () => {
    const r = await verifyFacts({ facts: [], source: src, commit: "c7c0001" });
    expect(r.secrets).toEqual([
      { file: ".env", line: 2, key: "STRIPE_API_KEY" },
      { file: ".env.production", line: 1, key: "DB_PASSWORD" },
      { file: "config/credentials.yml", line: 2, key: "password" },
      { file: "src/main/resources/application.yml", line: 1, key: "aws_access_key_id" },
      { file: "src/main/resources/application.yml", line: 2, key: "spring.datasource.url" },
      { file: "src/main/resources/application.yml", line: 8, key: "auth" },
      { file: "src/main/resources/settings.xml", line: 2, key: "password" },
      { file: "web.config", line: 2, key: "Password" },
      { file: "web.config", line: 3, key: "NorthwindApiKey" },
    ]);
    const text = JSON.stringify(r);
    for (const v of SECRET_VALUES) expect(text, v).not.toContain(v);
    // the env and credentials files are still no source a fact may cite
    expect(r.coverage.unknown).not.toContain(".env");
  });

  it("reads a config.json token's key from its XPath (s3)", () => {
    expect(
      liveSecretsIn("config.json", [
        "            {",
        `              "xpath": "/AssignMessage/Set/Headers/Header[@name='x-api-key']",`,
        '              "value": "nwlive-Q7f3Kd92LmZx41Rt"',
        "            },",
        "            {",
        '              "xpath": "/TargetEndpoint/HTTPTargetConnection/URL",',
        '              "value": "https://api.northwind.example/v1"',
        "            }",
      ]),
    ).toEqual([
      { file: "config.json", line: 3, key: "/AssignMessage/Set/Headers/Header[@name='x-api-key']" },
    ]);
  });
});
