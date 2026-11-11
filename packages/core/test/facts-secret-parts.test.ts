import { describe, expect, it } from "vitest";
import {
  configSecretField,
  Fact,
  hasSecretShape,
  parseFacts,
  parseFactsLines,
  redactFactLine,
} from "../src/index.js";

/**
 * Beta.25 review: a config fact's secret is caught by another field than its value too (its
 * source, a `cite.with` part), and a Basic authorization value is a secret by its shape. The
 * verifier refuses such a fact (`secret-value`); the schema accepts what it accepted in beta.24
 * (its value check as released), so a verified beta.24 facts file is still read whole. And a
 * name with a digit (`DB2_PASSWORD`, `northwind-oauth2`, `secret1`) is no credential.
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
const field = (f: Record<string, unknown>) => configSecretField(Fact.parse(f) as never);
const SECRET = "q8Zt4LmN2vXy7RkP0sWd";

describe("a config fact's secret", () => {
  it("keeps a secret-named token whose parts name only its file and environment", () => {
    expect(field(token({ source: "env:NORTHWIND_KEY" }))).toBeUndefined();
  });

  it("is found in a cite.with part", () => {
    expect(
      field(
        token(
          {},
          {
            with: [
              { file: "config.json", line: 7, value: "AM-Key.xml" },
              { file: "config.json", line: 12, value: SECRET },
            ],
          },
        ),
      ),
    ).toBe("cite.with");
  });

  it("is found in a part by its shape, whatever the key", () => {
    expect(
      field({
        ...token({ key: "/TargetEndpoint/HTTPTargetConnection/URL", target: "default.xml" }),
        cite: {
          file: "config.json",
          line: 11,
          value: "/TargetEndpoint/HTTPTargetConnection/URL",
          with: [
            { file: "config.json", line: 12, value: "https://svc:pa55w0rdQ@api.northwind.example" },
          ],
        },
      }),
    ).toBe("cite.with");
  });

  it("is found as its source", () => {
    expect(field(token({ source: SECRET }))).toBe("source");
  });

  it("keeps a part naming a parent key or a file, under a secret's key", () => {
    expect(
      field({
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
      }),
    ).toBeUndefined();
  });
});

describe("the schema, as beta.24 released it", () => {
  it("accepts a fact whose part or source carries a secret: the verifier refuses it", () => {
    expect(
      Fact.safeParse(token({}, { with: [{ file: "config.json", line: 12, value: SECRET }] }))
        .success,
    ).toBe(true);
    expect(Fact.safeParse(token({ source: SECRET })).success).toBe(true);
  });

  it("reads a beta.24 facts file whole, though one fact's part carries a secret", () => {
    const bad = JSON.stringify(
      token({}, { with: [{ file: "config.json", line: 12, value: SECRET }] }),
    );
    const good = JSON.stringify(token({ id: "config.key-source", source: "env:NORTHWIND_KEY" }));
    const r = parseFacts(`${bad}\n${good}\n`);
    expect(r.ok).toBe(true);
    expect(parseFactsLines(`${bad}\n${good}\n`).bad).toEqual([]);
  });

  it("still refuses a value that looks like a secret, as beta.24 did", () => {
    expect(Fact.safeParse(token({ value: SECRET })).success).toBe(false);
    expect(
      Fact.safeParse(
        token({ key: "ledger.url", value: "https://svc:pa55w0rdQ@ledger.forge.example" }),
      ).success,
    ).toBe(false);
  });
});

describe("a name with a digit, under a secret's key", () => {
  const k8s = (name: string, key: string) => ({
    kind: "config",
    id: "config.northwind-client-secret",
    repo: "forge-wallets",
    commit: "abcdef1",
    key: "NORTHWIND_CLIENT_SECRET",
    source: `secretKeyRef:${name}/${key}`,
    target: "forge-wallets",
    cite: {
      file: "deploy/k8s/deployment.yaml",
      line: 30,
      value: "NORTHWIND_CLIENT_SECRET",
      with: [
        { file: "deploy/k8s/deployment.yaml", line: 33, value: name },
        { file: "deploy/k8s/deployment.yaml", line: 34, value: key },
      ],
    },
  });
  it.each([
    ["northwind-oauth2", "client-secret"],
    ["forge-secrets-v2", "northwind"],
    ["db2-credentials", "password"],
    ["northwind-oauth", "secret1"],
  ])("is no secret: secretKeyRef %s/%s", (name, key) => {
    expect(field(k8s(name, key))).toBeUndefined();
  });

  const app = (key: string, over: Record<string, unknown>, withs: { value: string }[] = []) => ({
    kind: "config",
    id: "config.x",
    repo: "forge-wallets",
    commit: "abcdef1",
    key,
    cite: {
      file: "src/main/resources/application.yaml",
      line: 3,
      value: key.split(".").pop(),
      ...(withs.length
        ? {
            with: withs.map((w, i) => ({ file: "deploy/k8s/deployment.yaml", line: 20 + i, ...w })),
          }
        : {}),
    },
    ...over,
  });
  it.each([
    [
      "an env name in a part",
      app("spring.datasource.password", { source: "${DB2_PASSWORD}" }, [{ value: "DB2_PASSWORD" }]),
    ],
    [
      "an env name as the source",
      app("forge.oauth2.client-secret", { source: "OAUTH2_CLIENT_SECRET" }),
    ],
    [
      "a Secret's name in a part",
      app("northwind.client-secret", { source: "${NORTHWIND_CLIENT_SECRET}" }, [
        { value: "northwind-oauth2" },
      ]),
    ],
    [
      "a KVM's name in a part",
      app("northwind.api-key", { source: "kvm:northwind-keys-v2" }, [
        { value: "northwind-keys-v2" },
      ]),
    ],
    [
      "a versioned name in a part",
      app("ledger.token", { source: "vault:kv/ledger" }, [{ value: "ledger-v2" }]),
    ],
    [
      "a numbered name in a part",
      app("ledger.password", { source: "env:LEDGER_PASSWORD" }, [{ value: "secret1" }]),
    ],
  ])("is no secret: %s", (_, f) => {
    expect(field(f)).toBeUndefined();
    expect(Fact.safeParse(f).success).toBe(true);
  });

  it.each([
    ["a long mixed literal", SECRET],
    ["a short literal of every class", "Xk9-mP2_vL"],
    ["a long lowercase random literal", "k9x2m4p7q1w8e5r3t6y0"],
  ])("is a secret: %s", (_, v) => {
    expect(field(app("ledger.password", { source: "env:LEDGER_PASSWORD" }, [{ value: v }]))).toBe(
      "cite.with",
    );
  });
});

describe("a Basic authorization value", () => {
  it("is a secret by its shape", () => {
    expect(hasSecretShape("Basic dXNlcjpzM2NyZXRQYXNzdzByZA==")).toBe(true);
    expect(hasSecretShape("Authorization: Basic Zm9yZ2U6bm9ydGh3aW5kMQ==")).toBe(true);
  });

  it("is none in words (Basic authentication, a placeholder, a scheme alone)", () => {
    expect(hasSecretShape("Basic authentication is used here")).toBe(false);
    expect(hasSecretShape("Basic ${NORTHWIND_BASIC}")).toBe(false);
    expect(hasSecretShape("Basic")).toBe(false);
    expect(hasSecretShape('Basic realm="forge"')).toBe(false);
  });

  const auth = {
    kind: "config",
    id: "config.auth",
    repo: "forge-wallets-proxy",
    commit: "abcdef1",
    key: "/AssignMessage/Set/Headers/Header[@name='Authorization']",
    value: "Basic dXNlcjpzM2NyZXRQYXNzdzByZA==",
    cite: { file: "config.json", line: 1, value: "x" },
  };
  it("is found as an Authorization header token's value, which beta.24's schema accepted", () => {
    expect(Fact.safeParse(auth).success).toBe(true);
    expect(field(auth)).toBe("value");
  });
});

describe("a refused fact's line, as rejected.jsonl keeps it", () => {
  it("is redacted when a field carries a secret: value, source, parts and quote", () => {
    for (const f of [
      token({ value: SECRET }),
      token({ source: SECRET }),
      token({}, { with: [{ file: "config.json", line: 12, value: SECRET }] }),
      token({ source: "env:X" }, { quote: `"value": "${SECRET}"` }),
      { ...token({ key: "ledger.url", value: "https://svc:pa55w0rdQ@ledger.forge.example" }) },
      { ...token({ key: "x", value: "Basic dXNlcjpzM2NyZXRQYXNzdzByZA==" }) },
    ]) {
      const out = redactFactLine(JSON.stringify(f));
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("pa55w0rdQ");
      expect(out).not.toContain("dXNlcjpzM2NyZXRQYXNzdzByZA");
      expect(out).toContain("<redacted>");
      expect(JSON.parse(out).id).toBe("config.key");
    }
  });

  it("is kept as written when nothing in it is a secret", () => {
    const raw = JSON.stringify(token({ source: "env:NORTHWIND_KEY", commit: "NOT-A-SHA" }));
    expect(redactFactLine(raw)).toBe(raw);
  });

  it("is redacted line by line when it isn't JSON", () => {
    const out = redactFactLine(`{"kind":"config","key":"x.password","value":"${SECRET}"`);
    expect(out).not.toContain(SECRET);
  });
});
