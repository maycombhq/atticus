import { describe, expect, it } from "vitest";
import {
  ChecklistPack,
  ChecklistRule,
  Dialect,
  Finding,
  findingPath,
  parseTemplate,
  renderTemplate,
  rulesJsonSchemas,
  TemplateError,
  templateSources,
  type TemplateSource,
} from "../src/index.js";

describe("templates", () => {
  it("parses literal text, sources and filters", () => {
    expect(parseTemplate("${yaml:forge.yaml#service}.${attr.method | lower}")).toEqual([
      { expr: { source: { type: "yaml", file: "forge.yaml", key: "service" }, filters: [] } },
      { text: "." },
      { expr: { source: { type: "attr", name: "method" }, filters: [{ name: "lower" }] } },
    ]);
    expect(
      templateSources("${annotation.ForgeClient.service}-${config:gateway.url}-${match.2}"),
    ).toEqual([
      { type: "annotation", annotation: "ForgeClient", name: "service" },
      { type: "config", key: "gateway.url" },
      { type: "match", group: 2 },
    ]);
  });

  it("rejects unknown values, filters and broken syntax", () => {
    for (const bad of [
      "${attr}",
      "${foo.bar}",
      "${attr.x | shout}",
      "${attr.x",
      "${yaml:../x#k}",
      "${attr.x | lower('a')}",
      "${attr.x | default}",
    ]) {
      expect(() => parseTemplate(bad), bad).toThrow(TemplateError);
    }
  });

  it("renders with filters, and refuses to half-fill a value", () => {
    const values: Record<string, string> = {
      method: "Post",
      path: "/accounts/{id}/balance/",
      empty: "",
    };
    const resolve = (s: TemplateSource) => (s.type === "attr" ? values[s.name] : undefined);
    expect(renderTemplate("${attr.method | upper} ${attr.path | normalizePath}", resolve)).toBe(
      "POST /accounts/{}/balance",
    );
    expect(renderTemplate("${attr.missing}", resolve)).toBeUndefined();
    expect(renderTemplate("${attr.missing | default('none')}", resolve)).toBe("none");
    expect(renderTemplate("${attr.empty | default('none')}", resolve)).toBe("none");
    expect(renderTemplate("${attr.method | slug}", resolve)).toBe("post");
  });
});

const dialect = {
  schemaVersion: 1,
  name: "forge",
  version: "0.1.0",
  appliesTo: { marker: "forge.yaml" },
  rules: [
    {
      id: "forge-endpoint",
      description: "Endpoints",
      match: { annotation: "ForgeEndpoint", target: "method", files: ["src/**/*.java"] },
      emit: {
        kind: "Endpoint",
        id: "${yaml:forge.yaml#service}.${member.name | slug}",
        fields: {
          component: "${yaml:forge.yaml#service}",
          endpointType: "rest",
          pathOrTopic: "${attr.path}",
        },
      },
      confidence: "verified",
    },
  ],
  tests: [{ name: "one", files: { "forge.yaml": "service: a\n" }, expect: [] }],
};

describe("C2 dialect file", () => {
  const withRule = (patch: Record<string, unknown>) => ({
    ...dialect,
    rules: [{ ...dialect.rules[0], ...patch }],
  });
  const issues = (d: unknown) => {
    const r = Dialect.safeParse(d);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("accepts a well-formed dialect and fills defaults", () => {
    const d = Dialect.parse(dialect);
    expect(d.extends).toEqual([]);
    expect(d.rules[0]!.emit.evidence).toEqual({ source: "code" });
  });

  it("allows exactly one kind of match", () => {
    expect(
      issues(withRule({ match: { annotation: "A", baseClass: "B", files: ["*.java"] } })).length,
    ).toBeGreaterThan(0);
    expect(issues(withRule({ match: { files: ["*.java"] } })).length).toBeGreaterThan(0);
    expect(issues(withRule({ match: { regex: "(", files: ["*.txt"] } })).length).toBeGreaterThan(0);
  });

  it("only emits fields contract C1 defines, and not the engine's own fields", () => {
    expect(
      issues(withRule({ emit: { ...dialect.rules[0]!.emit, fields: { colour: "red" } } })),
    ).toContain("Endpoint has no field colour in contract C1");
    expect(
      issues(withRule({ emit: { ...dialect.rules[0]!.emit, fields: { confidence: "verified" } } })),
    ).toContain("confidence is set by the engine, not by a rule");
  });

  it("derives Interface ids and requires ids for everything else", () => {
    const iface = {
      kind: "Interface",
      fields: { from: "a", to: "b", via: "direct", normalizedPath: "/x", sync: "sync" },
    };
    expect(issues(withRule({ emit: iface }))).toEqual([]);
    expect(issues(withRule({ emit: { ...iface, id: "x" } }))).toContain(
      "Interface ids are derived (if-<hash>); leave id out",
    );
    expect(issues(withRule({ emit: { kind: "Endpoint", fields: {} } }))).toContain(
      "Endpoint needs an id template",
    );
  });

  it("checks templates against what the match can supply", () => {
    expect(
      issues(withRule({ emit: { ...dialect.rules[0]!.emit, id: "${attr.x | yell}" } })).join(),
    ).toContain("unknown filter");
    expect(issues(withRule({ match: { configKey: "a.b", files: ["*.yml"] } })).join()).toContain(
      "${attr.*} needs an annotation, methodCall, xpath, jsonPath or hclBlock match",
    );
    expect(
      issues(withRule({ emit: { ...dialect.rules[0]!.emit, id: "${match.1}" } })).join(),
    ).toContain("${match.N} needs a regex, configKey, xpath, jsonPath or hclBlock match");
    expect(
      issues(withRule({ emit: { ...dialect.rules[0]!.emit, id: "${system}" } })).join(),
    ).toContain("only for checklist questions");
  });

  it("never lets a rule claim asserted confidence", () => {
    expect(issues(withRule({ confidence: "asserted" })).length).toBeGreaterThan(0);
  });

  it("requires tests, unique rule ids and rules or a plugin", () => {
    expect(issues({ ...dialect, tests: [] })).toContain("every dialect ships at least one test");
    expect(issues({ ...dialect, rules: [dialect.rules[0], dialect.rules[0]] })).toContain(
      "duplicate rule id forge-endpoint",
    );
    expect(issues({ ...dialect, rules: [] })).toContain("a dialect needs rules or a plugin");
    expect(issues({ ...dialect, rules: [], plugin: { module: "./forge.js" } })).toEqual([]);
    expect(issues({ ...dialect, plugin: { module: "../outside.js" } }).length).toBeGreaterThan(0);
    expect(issues({ ...dialect, extends: ["forge"] })).toContain("a dialect can't extend itself");
    expect(issues({ ...dialect, tests: [{ name: "x", expect: [] }] })).toContain(
      "a test has either files or fixture, not both or neither",
    );
  });
});

const rule = {
  id: "vendor-timeouts-set",
  title: "Vendor calls have timeouts",
  layer: "org",
  lens: "architecture",
  appliesTo: { artifacts: ["design"] },
  severity: "blocking",
  check: {
    type: "deterministic",
    check: "settings-present",
    params: { settingKinds: ["timeout"] },
  },
  waivable: true,
  source: "Platform resilience standard",
  needs: [{ kind: "Setting", field: "settingKind", question: "What timeouts does ${record} use?" }],
};

describe("C3 checklist rules", () => {
  const issues = (r: unknown) => {
    const x = ChecklistRule.safeParse(r);
    return x.success ? [] : x.error.issues.map((i) => i.message);
  };

  it("accepts a rule and defaults its status and need scope", () => {
    const r = ChecklistRule.parse(rule);
    expect(r.status).toBe("active");
    expect(r.needs[0]!.scope).toBe("touched-systems");
    expect(r.evidenceRequired).toBe(true);
  });

  it("keeps constitution rules unwaivable and waivers for blocking rules only", () => {
    expect(issues({ ...rule, layer: "constitution" })).toContain(
      "constitution rules are never waivable",
    );
    expect(issues({ ...rule, severity: "risk" })).toContain(
      "only blocking rules can be waivable; others can simply be dismissed",
    );
  });

  it("reserves severity gap for knowledge-gap findings", () => {
    expect(issues({ ...rule, severity: "gap" }).length).toBeGreaterThan(0);
  });

  it("checks needs against contract C1 and questions against the allowed values", () => {
    expect(
      issues({ ...rule, needs: [{ kind: "Setting", field: "colour", question: "q" }] }),
    ).toContain("Setting has no field colour in contract C1");
    expect(
      issues({ ...rule, needs: [{ kind: "Setting", question: "${attr.x}?" }] }).join(),
    ).toContain("questions may only use");
  });

  it("supports AI checks with a real prompt", () => {
    expect(
      issues({
        ...rule,
        waivable: false,
        severity: "risk",
        check: { type: "ai", prompt: "Report a finding if the design has no rollback plan." },
      }),
    ).toEqual([]);
    expect(issues({ ...rule, check: { type: "ai", prompt: "short" } }).length).toBeGreaterThan(0);
  });

  it("allows extends or tightens, not both", () => {
    expect(issues({ ...rule, extends: "a", tightens: "b" })).toContain(
      "use extends or tightens, not both",
    );
  });

  it("validates a pack: unique ids, constitution rules only tightened", () => {
    const pack = { schemaVersion: 1, name: "p", version: "1.0.0", rules: [rule] };
    expect(ChecklistPack.safeParse(pack).success).toBe(true);
    expect(ChecklistPack.safeParse({ ...pack, rules: [rule, rule] }).success).toBe(false);
    const base = { ...rule, id: "base", layer: "constitution", waivable: false };
    const child = { ...rule, id: "child", extends: "base", waivable: false };
    const r = ChecklistPack.safeParse({ ...pack, rules: [base, child] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("only be tightened");
    expect(
      ChecklistPack.safeParse({
        ...pack,
        rules: [base, { ...child, extends: undefined, tightens: "base" }],
      }).success,
    ).toBe(true);
  });
});

const finding = {
  schemaVersion: 1,
  id: "f-0001",
  kind: "issue",
  change: "add-transfer-limit",
  gate: "architecture",
  round: 1,
  rule: "vendor-calls-through-gateway",
  layer: "constitution",
  lens: "architecture",
  severity: "blocking",
  artifact: "interfaces.md",
  locator: { record: "if-e7344c9455608119" },
  summary: "ledger-api calls Northwind Pay directly; S.GW.VND requires the gateway.",
  why: "Vendor traffic must pass the gateway for auth, rate limiting and audit.",
  fix: { text: "Route the call through a gateway proxy and change via to gateway." },
  evidence: [
    {
      source: "code",
      repo: "forge-ledger",
      path: "src/main/java/forge/ledger/NorthwindClient.java",
      line: 8,
    },
  ],
  waivable: false,
  createdAt: "2026-10-18T05:00:00Z",
};

const gap = {
  ...finding,
  id: "f-0002",
  kind: "knowledge-gap",
  rule: "vendor-timeouts-set",
  layer: "org",
  severity: "gap",
  artifact: "catalog",
  locator: { record: "ledger-api", field: "settingKind" },
  summary: "No timeout or retry settings are known for ledger-api's Northwind client.",
  why: "The vendor call can't be checked against S.GW.VND controls without them.",
  fix: { text: "Record the settings, or add them to the client config." },
  evidence: [{ source: "catalog", record: "ledger-api" }],
  question: {
    text: "What timeout and retry settings does ledger-api use for Northwind Pay?",
    owner: "team-ledger",
  },
  waivable: false,
};

describe("C3 findings", () => {
  const issues = (f: unknown) => {
    const x = Finding.safeParse(f);
    return x.success ? [] : x.error.issues.map((i) => i.message);
  };
  const resolved = (f: object, state: string, resolution: object) => ({
    ...f,
    state,
    resolution: { by: "tom", at: "2026-10-18T06:00:00Z", ...resolution },
  });

  it("accepts an issue and a knowledge gap", () => {
    expect(issues(finding)).toEqual([]);
    expect(issues(gap)).toEqual([]);
    expect(Finding.parse(finding).state).toBe("open");
  });

  it("discards a finding without evidence", () => {
    expect(issues({ ...finding, evidence: [] })).toContain(
      "a finding without evidence is discarded",
    );
    expect(issues({ ...finding, evidence: [{ source: "code" }] })).toContain(
      "evidence points at a record or a file",
    );
  });

  it("ties severity gap to knowledge gaps, with an owner question", () => {
    expect(issues({ ...finding, severity: "gap" })).toContain(
      "severity gap is only for knowledge gaps",
    );
    expect(issues({ ...gap, severity: "risk" })).toContain("a knowledge gap has severity gap");
    expect(issues({ ...gap, question: undefined })).toContain(
      "a knowledge gap carries an owner question",
    );
  });

  it("matches each state to its action", () => {
    expect(issues(resolved(finding, "applied", { action: "edit-and-apply" }))).toEqual([]);
    expect(issues(resolved(finding, "applied", { action: "ask", askedOf: "architect" }))).toContain(
      "state applied can't come from action ask",
    );
    expect(issues({ ...finding, state: "applied" })).toContain(
      "a finding in state applied records who resolved it and how",
    );
    expect(
      issues({
        ...finding,
        resolution: { action: "apply", by: "tom", at: "2026-10-18T06:00:00Z" },
      }),
    ).toContain("an open finding has no resolution");
  });

  it("needs reasons for Not relevant and Waive, and a target for Ask", () => {
    expect(issues(resolved(finding, "dismissed", { action: "not-relevant" }))).toContain(
      "not-relevant needs a reason",
    );
    expect(issues(resolved(finding, "asked", { action: "ask" }))).toContain(
      "ask needs who it was routed to",
    );
  });

  it("waives only blocking, waivable, non-constitution findings", () => {
    const waivable = { ...finding, layer: "org", rule: "pattern-code-known", waivable: true };
    expect(
      issues(
        resolved(waivable, "waived", { action: "waive", reason: "Fixed in the next release" }),
      ),
    ).toEqual([]);
    expect(issues(resolved(finding, "waived", { action: "waive", reason: "x" }))).toContain(
      "this finding can't be waived",
    );
    expect(
      issues(
        resolved({ ...waivable, severity: "risk" }, "waived", { action: "waive", reason: "x" }),
      ),
    ).toContain("only blocking findings can be waived");
    expect(issues({ ...finding, waivable: true })).toContain(
      "constitution findings are never waivable",
    );
  });

  it("resolves knowledge gaps only by Ask or Edit and apply", () => {
    expect(issues(resolved(gap, "asked", { action: "ask", askedOf: "team-ledger" }))).toEqual([]);
    expect(issues(resolved(gap, "dismissed", { action: "not-relevant", reason: "x" }))).toContain(
      "a knowledge gap is resolved by Ask or Edit and apply",
    );
  });

  it("files a finding under review/<gate>/<round>/", () => {
    expect(findingPath(Finding.parse(finding))).toBe("review/architecture/1/f-0001.yaml");
  });

  it("generates JSON Schema for all three files", () => {
    const s = rulesJsonSchemas() as Record<string, { $id: string }>;
    expect(Object.keys(s)).toEqual(["Dialect", "ChecklistPack", "Finding"]);
    expect(s.Finding!.$id).toBe("https://maycombhq.github.io/atticus/schema/rules/v1/Finding.json");
  });
});
