import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  citedFiles,
  cmpNatural,
  cmpText,
  interfaceId,
  mergeCatalog,
  normalizePath,
  parseFacts,
  projectFacts,
  serializeRecord,
  slugify,
  staleCite,
  stripParamConstraints,
  type Fact,
} from "../src/index.js";

// Review round 47 (catalog and rules).
const here = join(__dirname, "fixtures", "facts");

function factsOf(lines: object[]): Fact[] {
  const r = parseFacts(lines.map((l) => JSON.stringify(l)).join("\n"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues, null, 2));
  return r.facts;
}
let line = 0;
const base = (id: string, extra: object) => ({
  id,
  repo: "forge-orders",
  commit: "abcdef1",
  cite: { file: "src/a.ts", line: ++line, value: "x" },
  ...extra,
});
const catalogText = (records: readonly object[]) =>
  mergeCatalog({ records: records as never, systems: [], repos: [] })
    .records.map(serializeRecord)
    .join("---\n");

describe("route parameters with constraints and optional markers", () => {
  it("cuts a parameter to its name before the query string is dropped", () => {
    expect(normalizePath("/brands/{brandId:int?}/items")).toBe("/brands/{}/items");
    expect(normalizePath("/pages/{slug:regex(^[a-z]+$)}")).toBe("/pages/{}");
    expect(normalizePath("/codes/{code:regex(^\\d{3}$)}/label")).toBe("/codes/{}/label");
    expect(normalizePath("/orders/{id=5}?expand=lines#top")).toBe("/orders/{}");
    expect(normalizePath("/orders/${order?.id}/lines")).toBe("/orders/{}/lines");
    // A brace in a segment with other text keeps the parameter's name, as before.
    expect(normalizePath("/files/{name}.{ext:alpha}")).toBe("/files/{name}.{ext}");
    expect(stripParamConstraints("/a/{b")).toBe("/a/{b");
  });

  it("gives an Interface id C1 accepts, and the same one for every way of writing the route", () => {
    const a = interfaceId("web", "api", "GET", "/brands/{brandId:int?}/items");
    expect(a).toBe(interfaceId("web", "api", "GET", "/brands/{brandId}/items"));
    expect(a).not.toBe(interfaceId("web", "api", "GET", "/brands/{brandId:int?}/prices"));
  });

  it("projects the ASP.NET routes to the golden catalog (no record dropped, none merged)", () => {
    const text = readFileSync(join(here, "forge-catalog-routes.facts.jsonl"), "utf8");
    const p = parseFacts(text);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const projected = projectFacts(p.facts);
    expect(projected.issues).toEqual([]);
    const merged = mergeCatalog({ records: projected.records, systems: [], repos: [] });
    expect(merged.invalid).toEqual([]);
    const out = merged.records.map(serializeRecord).join("---\n");
    const golden = join(here, "forge-catalog-routes.expected.yaml");
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) writeFileSync(golden, out);
    expect(out).toBe(readFileSync(golden, "utf8"));
    const interfaces = merged.records.filter((r) => r.kind === "Interface");
    expect(interfaces).toHaveLength(4);
    const endpoints = merged.records.filter((r) => r.kind === "Endpoint");
    expect(endpoints.map((e) => (e as { normalizedPath?: string }).normalizedPath).sort()).toEqual([
      "/brands/{}/items",
      "/brands/{}/prices",
      "/codes/{}/label",
      "/pages/{}",
    ]);
  });
});

describe("catalog order is the same in every locale", () => {
  const original = String.prototype.localeCompare;
  afterEach(() => {
    String.prototype.localeCompare = original;
  });
  const inLocale = (locale: string) => {
    const c = new Intl.Collator(locale);
    String.prototype.localeCompare = function (this: string, that: string) {
      return c.compare(String(this), that);
    };
  };
  const lines = [
    base("l1", {
      kind: "entry",
      entryType: "event-topic",
      path: "orders.created",
      component: "aarhus-ledger",
    }),
    base("l2", {
      kind: "entry",
      entryType: "event-topic",
      path: "orders.paid",
      component: "zeta-audit",
    }),
    base("k1", { kind: "config", settingKind: "config", key: "a_b", value: "1" }),
    base("k2", { kind: "config", settingKind: "config", key: "a-b", value: "2" }),
    base("k3", { kind: "config", settingKind: "config", key: "ab", value: "3" }),
  ];

  it("gives the same bytes in en and da, whatever order the facts come in", () => {
    // The orders differ under ICU: `aa` sorts after `z` in Danish, and `_` before `-` in English.
    expect(new Intl.Collator("da").compare("aa", "z")).toBeGreaterThan(0);
    expect(new Intl.Collator("en").compare("a_b", "a-b")).toBeLessThan(0);
    const run = (order: object[]) => catalogText(projectFacts(factsOf(order)).records);
    inLocale("en");
    const en = run(lines);
    const enShuffled = run([...lines].reverse());
    inLocale("da");
    const da = run([lines[3]!, lines[0]!, lines[4]!, lines[2]!, lines[1]!]);
    String.prototype.localeCompare = original;
    const plain = run(lines);
    expect(enShuffled).toBe(en);
    expect(da).toBe(en);
    expect(plain).toBe(en);
    // Code-unit order: `-` (0x2d) before `_` (0x5f), `aarhus` before `zeta`.
    const ids = en
      .split("\n")
      .filter((l) => l.startsWith("id: "))
      .map((l) => l.slice(4));
    expect(ids.indexOf("forge-orders.a-b")).toBeLessThan(ids.indexOf("forge-orders.a_b"));
  });

  it("compares text by code unit and digit runs by number", () => {
    expect(["b", "a_b", "a-b", "Z", "aa"].sort(cmpText)).toEqual(["Z", "a-b", "a_b", "aa", "b"]);
    expect(["a.ts:10", "a.ts:9", "a.ts:09", "b.ts:1"].sort(cmpNatural)).toEqual([
      "a.ts:09",
      "a.ts:9",
      "a.ts:10",
      "b.ts:1",
    ]);
  });
});

describe("Deployment and Setting ids that meet", () => {
  const facts = () =>
    factsOf([
      base("d1", { kind: "deploy", platform: "kubernetes", env: "prod" }),
      base("d2", { kind: "deploy", platform: "lambda", env: "prod" }),
      base("d3", { kind: "deploy", platform: "kubernetes", env: "test" }),
      base("s3", { kind: "config", settingKind: "config", key: "x", env: "prod", value: "c" }),
      base("s4", { kind: "config", settingKind: "config", key: "prod.x", value: "d" }),
      base("s5", { kind: "config", settingKind: "config", key: "y", value: "e" }),
    ]);

  it("keeps two deployments for one env apart by platform, and leaves a lone one as it was", () => {
    const r = projectFacts(facts());
    expect(r.ids.d1).toBe("forge-orders.prod.kubernetes");
    expect(r.ids.d2).toBe("forge-orders.prod.lambda");
    expect(r.ids.d3).toBe("forge-orders.test");
    const merged = mergeCatalog({ records: r.records, systems: [], repos: [] });
    const deps = merged.records.filter((x) => x.kind === "Deployment");
    expect(deps.map((d) => [d.id, (d as { platform?: string }).platform])).toEqual([
      ["forge-orders.prod.kubernetes", "kubernetes"],
      ["forge-orders.prod.lambda", "lambda"],
      ["forge-orders.test", "kubernetes"],
    ]);
  });

  it("keeps an env's key and a dotted key apart with a short hash, stable across runs", () => {
    const r = projectFacts(facts());
    expect(r.ids.s3).toMatch(/^forge-orders\.prod\.x-[0-9a-f]{8}$/);
    expect(r.ids.s4).toMatch(/^forge-orders\.prod\.x-[0-9a-f]{8}$/);
    expect(r.ids.s3).not.toBe(r.ids.s4);
    expect(r.ids.s5).toBe("forge-orders.y");
    expect(projectFacts([...facts()].reverse()).ids).toEqual(r.ids);
    expect(r.issues).toEqual([]);
  });

  it("reports records of one kind and id that say different things", () => {
    // Two entries the same topic slug can't tell apart (`orders.created`, `orders-created`).
    const r = projectFacts(
      factsOf([
        base("t1", { kind: "entry", entryType: "event-topic", path: "orders.created" }),
        base("t2", { kind: "entry", entryType: "event-topic", path: "orders-created" }),
        // The same claim on two lines is one record: not reported.
        base("t3", { kind: "entry", entryType: "event-topic", path: "orders.paid" }),
        base("t4", { kind: "entry", entryType: "event-topic", path: "orders.paid" }),
      ]),
    );
    expect(r.issues).toEqual([
      {
        factId: "t1",
        code: "duplicate-record",
        message:
          "Endpoint forge-orders.on-orders-created is made by t1, t2, which say different things; the catalog merge would join them into one",
      },
    ]);
  });
});

describe("a call's auth and TLS lines are files it rests on", () => {
  const call = factsOf([
    base("c1", {
      kind: "call",
      callType: "rest",
      method: "GET",
      path: "/brands",
      to: "forge-catalog",
      auth: "oauth2",
      authCite: {
        file: "src/auth.ts",
        line: 4,
        value: "token",
        with: [{ file: "src/token-config.ts", line: 2, value: "clientId" }],
      },
      tls: "mtls",
      tlsCite: {
        file: "src/tls.ts",
        line: 7,
        value: "cert",
        with: [{ file: "src/keystore.ts", line: 3, value: "keystore" }],
      },
    }),
  ])[0]!;

  it("lists them, with their parts", () => {
    expect(citedFiles(call)).toEqual([
      "src/a.ts",
      "src/auth.ts",
      "src/token-config.ts",
      "src/tls.ts",
      "src/keystore.ts",
    ]);
  });

  it("reads the call again when one of them changed", () => {
    for (const file of ["src/auth.ts", "src/token-config.ts", "src/tls.ts", "src/keystore.ts"])
      expect(staleCite(call, [{ status: "modified", path: file }]), file).toEqual({
        file,
        how: "edited",
      });
  });
});

describe("names with no Latin letter or digit", () => {
  it("get a stable hashed id each, not one shared `unnamed`", () => {
    const a = slugify("注文");
    const b = slugify("Заказы");
    expect(a).toMatch(/^unnamed-[0-9a-f]{8}$/);
    expect(b).toMatch(/^unnamed-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(slugify("注文")).toBe(a);
    expect(slugify("...")).toMatch(/^unnamed-[0-9a-f]{8}$/);
    expect(slugify("   ")).toBe("unnamed");
    expect(slugify("Ledger Platform (EU)")).toBe("ledger-platform-eu");
  });

  it("keeps two such components apart in the catalog", () => {
    const r = projectFacts(
      factsOf([
        base("n1", {
          kind: "entry",
          entryType: "event-topic",
          path: "orders.a",
          component: "注文",
        }),
        base("n2", {
          kind: "entry",
          entryType: "event-topic",
          path: "orders.b",
          component: "請求",
        }),
      ]),
    );
    const comps = r.records.filter((x) => x.kind === "Component").map((x) => x.id);
    expect(comps).toHaveLength(2);
    expect(new Set(comps).size).toBe(2);
  });
});
