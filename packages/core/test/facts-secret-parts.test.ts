import { describe, expect, it } from "vitest";
import { Fact, hasSecretShape, parseFactsLines } from "../src/index.js";

/**
 * Beta.25 review: a config fact's secret never gets past the schema by another field than its
 * value: its source, a `cite.with` part or its quote. And a Basic authorization value is a
 * secret by its shape. The schema refuses the one fact; the others of the file are kept.
 */
const X = "/AssignMessage/Set/Headers/Header[@name='x-api-key']";
const token = (over: Record<string, unknown> = {}, cite: Record<string, unknown> = {}) => ({
  kind: "config",
  id: "config.key",
  repo: "forge-wallets-proxy",
  commit: "abcdef1",
  key: X,
  target: "AM-Key.xml",
  env: "prod",
  cite: {
    file: "config.json",
    line: 11,
    value: X,
    quote: `"xpath": "${X}",`,
    with: [
      { file: "config.json", line: 7, value: "AM-Key.xml" },
      { file: "config.json", line: 4, value: "prod" },
    ],
    ...cite,
  },
  ...over,
});

describe("a config fact's secret", () => {
  it("keeps a secret-named token whose parts name only its file and environment", () => {
    expect(Fact.safeParse(token({ source: "env:NORTHWIND_KEY" })).success).toBe(true);
  });

  it("is refused in a cite.with part", () => {
    const r = Fact.safeParse(
      token(
        {},
        {
          with: [
            { file: "config.json", line: 7, value: "AM-Key.xml" },
            { file: "config.json", line: 12, value: "q8Zt4LmN2vXy7RkP0sWd" },
          ],
        },
      ),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain("q8Zt4LmN2vXy7RkP0sWd");
  });

  it("is refused in a part by its shape, whatever the key", () => {
    const r = Fact.safeParse({
      ...token({ key: "/TargetEndpoint/HTTPTargetConnection/URL", target: "default.xml" }),
      cite: {
        file: "config.json",
        line: 11,
        value: "/TargetEndpoint/HTTPTargetConnection/URL",
        with: [
          { file: "config.json", line: 12, value: "https://svc:pa55w0rdQ@api.northwind.example" },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it("is refused as its source", () => {
    expect(Fact.safeParse(token({ source: "q8Zt4LmN2vXy7RkP0sWd" })).success).toBe(false);
  });

  it("leaves its quote to the verifier, which redacts it as it always has", () => {
    const r = Fact.safeParse(
      token({ source: "env:NORTHWIND_KEY" }, { quote: `"value": "${"<redacted>"}"` }),
    );
    expect(r.success).toBe(true);
  });

  it("keeps a part naming a parent key or a file, under a secret's key", () => {
    const r = Fact.safeParse({
      kind: "config",
      id: "config.db-password",
      repo: "forge-wallets",
      commit: "abcdef1",
      key: "spring.datasource.password",
      source: "env:DB_PASSWORD",
      cite: {
        file: "src/main/resources/application.yml",
        line: 4,
        value: "password",
        with: [
          { file: "src/main/resources/application.yml", line: 2, value: "datasource" },
          { file: "src/main/resources/application.yml", line: 1, value: "spring" },
        ],
      },
    });
    expect(r.success).toBe(true);
  });

  it("refuses the one fact, keeping the rest of the file", () => {
    const bad = JSON.stringify(
      token({}, { with: [{ file: "config.json", line: 12, value: "q8Zt4LmN2vXy7RkP0sWd" }] }),
    );
    const good = JSON.stringify(token({ id: "config.key-source", source: "env:NORTHWIND_KEY" }));
    const r = parseFactsLines(`${bad}\n${good}\n`);
    expect(r.facts.map((f) => f.id)).toEqual(["config.key-source"]);
    expect(r.bad).toHaveLength(1);
  });
});

describe("a Basic authorization value", () => {
  it("is a secret by its shape", () => {
    expect(hasSecretShape("Basic dXNlcjpzM2NyZXRQYXNzdzByZA==")).toBe(true);
    expect(hasSecretShape("Authorization: Basic Zm9yZ2U6bm9ydGh3aW5kMQ==")).toBe(true);
  });

  it("is none in words (Basic authentication, a placeholder)", () => {
    expect(hasSecretShape("Basic authentication is used here")).toBe(false);
    expect(hasSecretShape("Basic ${NORTHWIND_BASIC}")).toBe(false);
  });

  it("is refused as an Authorization header token's value", () => {
    const r = Fact.safeParse({
      kind: "config",
      id: "config.auth",
      repo: "forge-wallets-proxy",
      commit: "abcdef1",
      key: "/AssignMessage/Set/Headers/Header[@name='Authorization']",
      value: "Basic dXNlcjpzM2NyZXRQYXNzdzByZA==",
      cite: { file: "config.json", line: 1, value: "x" },
    });
    expect(r.success).toBe(false);
  });
});
