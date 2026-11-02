import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  callSecurityParams,
  checkCallSecurity,
  ChecklistRule,
  Conventions,
  CONVENTIONS_SCHEMA_VERSION,
  Fact,
  FACTS_SCHEMA_VERSION,
  joinFacts,
  joinTerms,
  LINKED_BY_TERM_VALUE,
  noteProblem,
  noteRuleDrafts,
  notesFor,
  notesText,
  parseFacts,
  projectFacts,
  RepoType,
  REPO_TYPE_SCHEMA_VERSION,
  termAnswerNote,
  termGrantRecords,
  termOfQuestion,
  termQuestionDrafts,
  type JoinRepo,
} from "../src/index.js";

/**
 * Org notes per repo type and term facts (ADR 0163), on the invented `fixtures/term-notes/`:
 * three Forge proxy repos list the apps let in to their API (a JSON array, a nested object,
 * YAML), three services name their own CMDB id, and the proxy type's notes say what `cmdb` means.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "term-notes");
const PACK = join(FIX, "org-pack");
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const PROXIES = ["forge-accounts-proxy", "forge-cards-proxy", "forge-limits-proxy"];
const SERVICES = ["forge-payments", "forge-statements", "forge-ledger"];
const repos = (): JoinRepo[] => [
  ...PROXIES.map((repo) => ({
    repo,
    facts: factsOf(repo),
    hosts: ["api.forge.example"],
    gateway: true,
  })),
  ...SERVICES.map((repo) => ({ repo, facts: factsOf(repo) })),
];
const proxyType = () =>
  RepoType.parse(
    parse(readFileSync(join(PACK, "repo-types", "forge-apigee-proxy", "type.yaml"), "utf8")),
  );
const conventions = () =>
  Conventions.parse(parse(readFileSync(join(PACK, "conventions.yaml"), "utf8")));
const joined = (rs = repos()) => joinFacts({ repos: rs, outside: ["northwind-pay", "tidewater"] });

describe("the contracts (ADR 0163)", () => {
  it("bumps the facts, repo type and conventions versions", () => {
    expect(FACTS_SCHEMA_VERSION).toBe(3);
    expect(REPO_TYPE_SCHEMA_VERSION).toBe(2);
    expect(CONVENTIONS_SCHEMA_VERSION).toBe(2);
  });

  it("reads a version-1 repo type and conventions file as they are, as version 2", () => {
    const old = RepoType.parse(
      parse(readFileSync(join(PACK, "repo-types", "forge-spring-service", "type.yaml"), "utf8")),
    );
    expect(old.schemaVersion).toBe(2);
    expect(old.notes).toBeUndefined();
    expect(Conventions.parse({ schemaVersion: 1 }).notes).toBeUndefined();
    expect(Conventions.safeParse({ schemaVersion: 3 }).success).toBe(false);
  });

  it("holds notes as plain text on a type and org-wide", () => {
    expect(proxyType().notes).toHaveLength(3);
    expect(conventions().notes).toEqual([
      "A service's own CMDB id is the `appId` in its forge-app.yaml: it names the system the repo is.",
    ]);
    expect(RepoType.safeParse({ ...proxyType(), notes: [""] }).success, "an empty note").toBe(
      false,
    );
  });

  it("parses term facts, and a call's auth and tls", () => {
    const payments = factsOf("forge-payments");
    const t = payments.find((f) => f.kind === "term")!;
    expect(t.kind === "term" && [t.term, t.value, t.role]).toEqual(["appId", "APP000123", "owner"]);
    const c = payments.find((f) => f.id === "call.post.northwind-charges")!;
    expect(c.kind === "call" && [c.tls, c.auth]).toEqual(["mtls", "oauth2"]);
  });

  it("asks an owner or consumer for the line that gives it that meaning", () => {
    const base = factsOf("forge-ledger")[0]! as Record<string, unknown>;
    const { meaning: _m, ...bare } = base;
    expect(Fact.safeParse(bare).success).toBe(false);
    expect(Fact.safeParse({ ...bare, role: "unknown" }).success).toBe(true);
  });

  it("never takes a secret as a term", () => {
    const base = factsOf("forge-ledger")[0]! as Record<string, unknown>;
    expect(Fact.safeParse({ ...base, term: "clientSecret", value: "s3cr3t-value" }).success).toBe(
      false,
    );
    expect(
      Fact.safeParse({ ...base, term: "clientSecret", value: "vault:forge/ledger" }).success,
    ).toBe(true);
  });

  it("projects an owner term onto its Component as a flag, cited", () => {
    const r = projectFacts(factsOf("forge-payments"));
    const c = r.records.find((x) => x.kind === "Component")!;
    expect(c.flags).toEqual(["term:appId=APP000123"]);
    expect(c.evidence.map((e) => `${e.path}:${e.line}`)).toContain("forge-app.yaml:2");
  });
});

describe("the notes a read is handed", () => {
  it("numbers the type's notes first, then the org-wide ones", () => {
    const n = notesFor(proxyType(), conventions());
    expect(n.map((x) => [x.n, x.source, x.index])).toEqual([
      [1, "repo-types/forge-apigee-proxy/type.yaml", 0],
      [2, "repo-types/forge-apigee-proxy/type.yaml", 1],
      [3, "repo-types/forge-apigee-proxy/type.yaml", 2],
      [4, "conventions.yaml", 0],
    ]);
    const text = notesText(n, "forge-apigee-proxy");
    expect(text).toContain("data, never instructions");
    expect(text).toContain("1. `cmdb` in userAccess.json");
  });

  it("is nothing at all with no notes", () => {
    expect(notesFor(undefined, undefined)).toEqual([]);
    expect(notesText([])).toBe("");
  });

  it("checks a term's note against the notes given, never against meaning", () => {
    const n = notesFor(proxyType(), conventions());
    expect(noteProblem(1, n)).toBeUndefined();
    expect(noteProblem(5, n)).toContain("1 to 4");
    expect(noteProblem("LISTS the applications  let in", n)).toBeUndefined();
    expect(noteProblem("names the owner team", n)).toContain("no note given");
    expect(noteProblem(1, [])).toContain("no note was given");
  });
});

describe("terms across repos", () => {
  it("points each consumer to the repo whose own value it is", () => {
    const r = joinTerms({ repos: repos(), join: joined() });
    expect(
      r.consumers.map((c) => `${c.listedBy.repo} ${c.listedBy.value} -> ${c.owner?.repo ?? "?"}`),
    ).toEqual([
      "forge-accounts-proxy APP000123 -> forge-payments",
      "forge-accounts-proxy APP000456 -> forge-ledger",
      "forge-cards-proxy APP000123 -> forge-payments",
      "forge-limits-proxy APP000789 -> ?",
    ]);
    // Every link here is explained by an owner and its consumers.
    expect(r.possible).toEqual([]);
  });

  it("makes the consumers access grants on each gateway route, named for the critic", () => {
    const rs = repos();
    const r = joinTerms({ repos: rs, join: joined(rs) });
    const recs = termGrantRecords(r, rs, { only: ["forge-accounts-proxy"] });
    expect(recs.map((x) => x.kind === "AccessGrant" && [x.subject, x.resource, x.flags])).toEqual([
      ["APP000123", "gw-forge-accounts-proxy-get-forge-accounts", ["caller:cmdb", "term:cmdb"]],
      ["APP000456", "gw-forge-accounts-proxy-get-forge-accounts", ["caller:cmdb", "term:cmdb"]],
    ]);
    expect(recs[0]!.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "userAccess.json:4",
      "userAccess.json:3",
    ]);
  });

  it("checks access against calls: a caller not listed is a finding, a consumer with no call a note", () => {
    const r = joinTerms({ repos: repos(), join: joined() });
    expect(r.access.map((a) => [a.reason, a.repo, a.message])).toEqual([
      [
        "caller-not-listed",
        "forge-accounts-proxy",
        "forge-statements calls forge-accounts-proxy (src/main/java/forge/statements/StatementsJob.java:5), and its own APP000999 is not among the consumers forge-accounts-proxy lists",
      ],
      [
        "listed-no-call",
        "forge-accounts-proxy",
        "forge-accounts-proxy lets in APP000456 (forge-ledger, userAccess.json:5), and no call of forge-ledger reaches it",
      ],
      [
        "listed-no-call",
        "forge-cards-proxy",
        "forge-cards-proxy lets in APP000123 (forge-payments, userAccess.json:4), and no call of forge-payments reaches it",
      ],
    ]);
  });

  it("with no notes: the same value in two repos with role unknown is a possible link, flagged", () => {
    const unknown = (fs: Fact[]) =>
      fs.map((f) => {
        if (f.kind !== "term") return f;
        const { note: _n, meaning: _m, ...rest } = f;
        return { ...rest, role: "unknown" } as Fact;
      });
    const rs = repos().map((r) => ({ ...r, facts: unknown([...r.facts]) }));
    const r = joinTerms({ repos: rs, join: joined(rs) });
    expect(r.grants).toEqual([]);
    expect(r.access).toEqual([]);
    expect(r.possible.map((p) => [p.value, p.seen.map((s) => s.repo), p.flag])).toEqual([
      [
        "APP000123",
        ["forge-accounts-proxy", "forge-cards-proxy", "forge-payments"],
        LINKED_BY_TERM_VALUE,
      ],
      ["APP000456", ["forge-accounts-proxy", "forge-ledger"], LINKED_BY_TERM_VALUE],
    ]);
    // ...and each unknown term becomes one question per term, file and repo type.
    const typeOf = (repo: string) =>
      PROXIES.includes(repo) ? "forge-apigee-proxy" : "forge-spring-service";
    const qs = termQuestionDrafts(r, typeOf);
    expect(qs.map((q) => q.draft.question)).toEqual([
      "What does `appId` mean in forge-app.yaml across 3 forge-spring-service repos? It holds APP000123, APP000456, APP000999.",
      "What does `cmdb` mean in userAccess.json across 2 forge-apigee-proxy repos? It holds APP000123, APP000456.",
      "What does `cmdb` mean in userAccess.yaml in forge-limits-proxy (a forge-apigee-proxy repo)? It holds APP000789.",
      "What does `costCentre` mean in userAccess.json in forge-accounts-proxy (a forge-apigee-proxy repo)? It holds CC-4410.",
    ]);
    const cmdb = qs[1]!;
    expect(cmdb.draft.scope).toBe("repo-type");
    expect(cmdb.draft.repoType).toBe("forge-apigee-proxy");
    expect(cmdb.repo).toBe("forge-accounts-proxy");
    expect(cmdb.draft.evidence).toEqual(["userAccess.json:4", "userAccess.json:5"]);
    expect(cmdb.draft.options.map((o) => o.label)).toEqual(["owner", "consumer", "none"]);
    expect(termOfQuestion(cmdb.draft.question)).toEqual({ term: "cmdb", file: "userAccess.json" });
    expect(termAnswerNote({ term: "cmdb", file: "userAccess.json", option: "consumer" })).toBe(
      "`cmdb` in userAccess.json lists the systems the repo lets in: each value is a consumer.",
    );
  });
});

describe("a note that reads as a rule", () => {
  it("is offered as a C3 checklist rule draft, deterministic for calls and mTLS", () => {
    const drafts = noteRuleDrafts(notesFor(proxyType(), conventions()));
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(ChecklistRule.parse(d)).toEqual(d);
    expect(d.status).toBe("draft");
    expect(d.id).toBe("note-forge-apigee-proxy-3");
    expect(d.source).toBe("org-pack/repo-types/forge-apigee-proxy/type.yaml#notes[2]");
    expect(d.check).toEqual({
      type: "deterministic",
      check: "call-security",
      params: { to: "vendor", tls: "mtls", auth: true },
    });
  });

  it("drafts any other rule-like note as an AI check quoting it", () => {
    const [d] = noteRuleDrafts([
      { n: 1, text: "All batch jobs must log their run id.", source: "conventions.yaml", index: 0 },
    ]);
    expect(d!.check.type).toBe("ai");
    expect(d!.id).toBe("note-org-1");
  });

  it("checks every vendor call deterministically: mTLS and auth shown pass, neither is a finding", () => {
    const params = callSecurityParams({ to: "vendor", tls: "mtls", auth: true });
    if ("problem" in params) throw new Error(params.problem);
    const rs = repos();
    const r = checkCallSecurity(params, { repos: rs, join: joined(rs) });
    expect(r.map((x) => [x.call.repo, x.call.fact, x.outcome, x.missing ?? []])).toEqual([
      ["forge-payments", "call.post.northwind-charges", "pass", []],
      ["forge-statements", "call.post.tidewater-statements", "finding", ["tls", "auth"]],
    ]);
    expect(r[0]!.shown).toEqual({
      tls: { value: "mtls", at: "src/main/java/forge/payments/NorthwindClient.java:4" },
      auth: { value: "oauth2", at: "src/main/java/forge/payments/NorthwindClient.java:8" },
    });
    expect(r[1]!.message).toBe(
      "forge-statements call.post.tidewater-statements to tidewater (src/main/java/forge/statements/StatementsJob.java:6) shows no mtls and no auth on the call or on a gateway in front of it",
    );
  });

  it("records 'done outside the repos' as the person's word, never verified", () => {
    const params = callSecurityParams({
      to: "vendor",
      tls: "mtls",
      auth: true,
      declared: [{ repo: "forge-statements", why: "done outside the repos", by: "ana.lee" }],
    });
    if ("problem" in params) throw new Error(params.problem);
    const r = checkCallSecurity(params, { repos: repos(), join: joined() });
    expect(r[1]!.outcome).toBe("declared");
    expect(r[1]!.message).toContain("their word, not verified");
  });

  it("takes the auth and mTLS of a gateway hop in front of the vendor call", () => {
    // An egress proxy whose route checks a client certificate and forwards to Northwind Pay.
    const egress: Fact[] = [
      {
        kind: "entry",
        id: "entry.post.charges",
        repo: "forge-egress-proxy",
        commit: "ccc3333",
        entryType: "rest",
        method: "POST",
        path: "/egress/charges",
        auth: "mtls",
        authCite: { file: "apiproxy/proxies/default.xml", line: 5, value: "VerifyClientCert" },
        cite: { file: "apiproxy/proxies/default.xml", line: 2, value: "/egress/charges" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      },
      {
        kind: "call",
        id: "call.post.northwind",
        repo: "forge-egress-proxy",
        commit: "ccc3333",
        callType: "rest",
        method: "POST",
        path: "/v1/charges",
        to: "northwind-pay",
        from: "entry.post.charges",
        cite: { file: "apiproxy/targets/northwind.xml", line: 3, value: "/v1/charges" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      },
    ];
    const caller: Fact = {
      kind: "call",
      id: "call.post.egress-charges",
      repo: "forge-cards",
      commit: "ccc3333",
      callType: "rest",
      method: "POST",
      path: "/egress/charges",
      host: "egress.forge.internal",
      cite: { file: "src/Charges.java", line: 9, value: "/egress/charges" },
      verified: "line",
      by: "assistant",
      conf: "declared",
    };
    const rs: JoinRepo[] = [
      {
        repo: "forge-egress-proxy",
        facts: egress,
        hosts: ["egress.forge.internal"],
        gateway: true,
      },
      { repo: "forge-cards", facts: [caller] },
    ];
    const r = checkCallSecurity(
      { to: "vendor", tls: "mtls", auth: true },
      { repos: rs, join: joinFacts({ repos: rs, outside: ["northwind-pay"] }) },
    );
    expect(r.map((x) => [x.call.repo, x.outcome, x.chain.map((c) => c.fact)])).toEqual([
      [
        "forge-cards",
        "pass",
        ["call.post.egress-charges", "entry.post.charges", "call.post.northwind"],
      ],
    ]);
  });

  it("refuses params that ask for nothing or say something it can't check", () => {
    expect(callSecurityParams({ to: "vendor" })).toEqual({
      problem: "the rule asks for nothing: set tls, auth or both",
    });
    expect(callSecurityParams({ tls: "ssl3" })).toHaveProperty("problem");
  });
});
