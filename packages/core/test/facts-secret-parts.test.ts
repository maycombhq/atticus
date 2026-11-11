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

/**
 * Beta.25 review, second round: under a key that names a secret, a source is a reference
 * (`env:`, `vault:`, `${NAME}`, `secretKeyRef:`, `file:`, `kvm:`, a scheme then a name or a path)
 * or a name as people write one (`DB2_PASSWORD`, `forge-secrets-v2`, `clientSecretV2`); any
 * other literal is the secret, however weak. A placeholder's literal default under such a key
 * is the secret too, and a credential with a `/` in it (an AWS secret access key) is no path.
 */
describe("a source under a secret's key", () => {
  const db = (over: Record<string, unknown>, withs: { value: string }[] = []) => ({
    kind: "config",
    id: "config.db-password",
    repo: "forge-wallets",
    commit: "abcdef1",
    key: "spring.datasource.password",
    cite: {
      file: "src/main/resources/application.yml",
      line: 4,
      value: "password",
      ...(withs.length
        ? { with: withs.map((w, i) => ({ file: "deploy/values.yaml", line: 2 + i, ...w })) }
        : {}),
    },
    ...over,
  });

  it.each(["hunter22", "p4ssw0rd", "changeme123", "Summer2024!", "changeme", "Password1"])(
    "is the secret when it is a literal, whatever its strength: %s",
    (v) => {
      expect(field(db({ source: v }))).toBe("source");
    },
  );

  it.each([
    "env:DB_PASSWORD",
    "vault:kv/forge/ledger",
    "${DB2_PASSWORD}",
    "${DB_PASSWORD:}",
    "${DB_PASSWORD:${VAULT_DB_PASSWORD}}",
    "{{ db_password }}",
    "secretKeyRef:db2-credentials/password",
    "configMapKeyRef:forge-db/password",
    "file:/run/secrets/db-password",
    "kvm:northwind-keys-v2",
    "aws-sm:arn:aws:secretsmanager:us-east-1:123456789012:secret:forge-db",
    "DB2_PASSWORD",
    "PASSWORD",
    "forge-secrets-v2",
    "ledger.db.password",
    "clientSecretV2",
    "Db2Credentials",
    "config/app.yml",
    "src/main/java/forge/Creds.java",
    "application-prod.yml",
    "the Kubernetes Secret forge-db",
  ])("is no secret when it is a reference or a name: %s", (v) => {
    expect(field(db({ source: v }))).toBeUndefined();
  });

  it.each([
    "${DB_PASSWORD:hunter22}",
    "${DB_PASSWORD:-changeme}",
    "${A:${B:q8Zt4LmN2vXy7RkP0sWd}}",
  ])("is the secret when a placeholder's default is a literal: %s", (v) => {
    expect(field(db({ source: v }))).toBe("source");
    expect(field(db({ value: v }))).toBe("value");
  });

  it("leaves a placeholder's literal default alone under a key that names no secret", () => {
    expect(
      field(db({ key: "forge.ledger.url", value: "${LEDGER_URL:http://localhost:8081}" })),
    ).toBeUndefined();
  });

  it("is read by the schema as beta.24 read it: the verifier refuses it", () => {
    expect(Fact.safeParse(db({ source: "hunter22" })).success).toBe(true);
    expect(Fact.safeParse(db({ value: "${DB_PASSWORD:hunter22}" })).success).toBe(true);
  });

  it("finds an AWS secret access key with a / in it in a part", () => {
    const f = db({ key: "forge.aws.secret-access-key", source: "env:AWS_SECRET_ACCESS_KEY" }, [
      { value: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    ]);
    expect(field(f)).toBe("cite.with");
  });

  it("finds a password by its marks in a part (`Summer2024!`)", () => {
    expect(field(db({ source: "env:DB_PASSWORD" }, [{ value: "Summer2024!" }]))).toBe("cite.with");
  });

  it("keeps a part that is a path of names", () => {
    expect(
      field(
        db({ source: "vault:secret/data/forge-ledger" }, [{ value: "secret/data/forge-ledger2" }]),
      ),
    ).toBeUndefined();
  });
});

describe("a facts line that isn't JSON, under a secret's key", () => {
  it.each([
    ['{"kind":"config","key":"db.password","value":"hunter22" BROKEN', "hunter22"],
    ['{"kind":"config","key":"db.password","source":"p4ssw0rd","x":', "p4ssw0rd"],
    ['{"kind":"config","key":"db.password","value":"changeme123', "changeme123"],
    [
      '{"kind":"config","key":"db.password","cite":{"with":[{"file":"a.yml","line":2,"value":"Summer2024!"}]',
      "Summer2024!",
    ],
    ['{"kind":"config","value":"hunter22","key":"db.password" BROKEN', "hunter22"],
  ])("has its value redacted, however weak: %s", (line, secret) => {
    const out = redactFactLine(line);
    expect(out).not.toContain(secret);
    expect(out).toContain("<redacted>");
    expect(out).toContain('"key":"db.password"');
  });

  it("keeps a broken line's value when its key names no secret", () => {
    const raw = '{"kind":"config","key":"forge.url","value":"https://x.forge.example" BROKEN';
    expect(redactFactLine(raw)).toBe(raw);
  });
});
