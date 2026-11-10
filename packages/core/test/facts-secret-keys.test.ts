import { describe, expect, it } from "vitest";
import { Fact, looksLikeSecret, partsBuildWord } from "../src/index.js";

/**
 * Beta.24 review: a deploy tool's token (the Apigee config plugin's `config.json`) names what it
 * sets by an XPath, so a secret's name sits in a bracketed name or the path's last element, never
 * after a `.` or `:`. Such a token, or any config fact whose value has a well-known token shape,
 * is refused by the facts schema, and the error never echoes the value.
 */
const SECRET = "nwlive-Q7f3Kd92LmZx41Rt";

describe("a secret named by an XPath key", () => {
  it("is caught in a bracketed name or the last element", () => {
    for (const k of [
      "/AssignMessage/Set/Headers/Header[@name='x-api-key']",
      "/AssignMessage/AssignVariable[Name='private.clientSecret']/Value",
      "/TargetEndpoint/HTTPTargetConnection/SSLInfo/KeyStorePassword",
      'Header[@name="Authorization-Token"]',
    ])
      expect(looksLikeSecret(k, SECRET), k).toBe(true);
  });

  it("leaves a URL's XPath, a key that only mentions a secret word, and the old shapes as they were", () => {
    expect(
      looksLikeSecret(
        "/TargetEndpoint/HTTPTargetConnection/URL",
        "https://api.northwind.example/v1",
      ),
    ).toBe(false);
    expect(looksLikeSecret("oauth.TokenUrl", "https://auth.example/token")).toBe(false);
    expect(looksLikeSecret("password-policy", "strong")).toBe(false);
    expect(looksLikeSecret("db.password", "s3cr3t-Pa55word")).toBe(true);
    expect(looksLikeSecret("Db__Password", "s3cr3t-Pa55word")).toBe(true);
    expect(looksLikeSecret("vendor.api_key", "${VENDOR_KEY}")).toBe(false);
  });

  it("is refused by the facts schema, its value never in the error (s3)", () => {
    const r = Fact.safeParse({
      kind: "config",
      id: "config.nw-key-prod",
      repo: "northwind_wallets_1-0",
      commit: "8888aaa",
      key: "/AssignMessage/Set/Headers/Header[@name='x-api-key']",
      value: SECRET,
      target: "AM-SetKey.xml",
      env: "prod",
      cite: {
        file: "config.json",
        line: 11,
        value: "/AssignMessage/Set/Headers/Header[@name='x-api-key']",
      },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).not.toContain(SECRET);
  });

  it("refuses a config value of a well-known token shape, whatever its key", () => {
    for (const value of [
      "AKIAIOSFODNN7EXAMPLE",
      "sk_live_abcdef1234567890",
      "jdbc:postgresql://forge:Pa55w0rdLive@db.forge.example/forge",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmn",
    ]) {
      const r = Fact.safeParse({
        kind: "config",
        id: "config.x",
        repo: "forge-wallets",
        commit: "8888aaa",
        key: "/AssignMessage/Set/Headers/Header[@name='x-forge-hdr']",
        value,
        cite: { file: "config.json", line: 1, value: "x" },
      });
      expect(r.success, value).toBe(false);
      expect(JSON.stringify(r.error)).not.toContain(value);
    }
  });
});

describe("a word built from parts (beta.24 review)", () => {
  it("is never all parts: the cited lines name some of it", () => {
    expect(partsBuildWord("schedule:triage", ["schedule", "triage"], ["unrelated();"])).toBe(false);
  });

  it("takes no piece of a hyphenated word from another line", () => {
    expect(partsBuildWord("forge-remote", ["forge"], ["remote: x"])).toBe(false);
    expect(partsBuildWord("forge-remote:sync", ["forge-remote"], ["task :sync"])).toBe(true);
  });
});
