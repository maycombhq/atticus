import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  loadOrgPack,
  parseFacts,
  serializeRecord,
  type CatalogRecord,
  type Fact,
  type FlowRecord,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  estateFacts,
  estateFlow,
  estateFromFacts,
  fieldLineage,
  flattenEstateFlow,
  joinEstate,
  targetQuestionDrafts,
  targetsFromAnswers,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * The estate from facts (ADR 0124 addendum C-join): three repos' facts written one by one with
 * `atticus verify <repo> --write`, each write joining the repo's calls to the other repos'
 * entries (and the other repos' calls to its own), so the catalog is the same whichever repo
 * is written first, and the flows follow the joins across repos.
 */

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");
const REPOS = ["forge-web", "forge-customers", "forge-ledger"] as const;
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(ESTATE, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const all = () => REPOS.map((repo) => ({ repo, facts: factsOf(repo) }));

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(ESTATE, "org-pack"));
});

/** Write the repos in this order, each with the others' facts as the estate. */
function writeAll(order: readonly string[]) {
  let records: CatalogRecord[] = [];
  const flows: Record<string, FlowRecord[]> = {};
  const results = [];
  for (const repo of order) {
    const out = catalogWithFacts({
      repo,
      facts: factsOf(repo),
      existing: records,
      op,
      decisions: [],
      estate: all().filter((x) => x.repo !== repo),
    });
    expect(out.invalid).toEqual([]);
    records = out.records;
    flows[repo] = out.flows;
    results.push(out);
  }
  return { records, flows, results };
}
const byId = (rs: readonly CatalogRecord[], id: string) => rs.find((r) => r.id === id);
const text = (rs: readonly CatalogRecord[]) => rs.map((r) => serializeRecord(r)).join("---\n");

describe("catalogWithFacts with the estate: calls joined to the entries of the repo that serves them", () => {
  it("joins with a citation at both ends, and the config that ties a base URL to its host", () => {
    const { records } = writeAll(REPOS);
    const create = byId(records, "if-0f06d434a34c81c9");
    expect(create).toMatchObject({
      kind: "Interface",
      from: "web-app",
      to: "customers-api",
      endpoint: "customers-api.post-customer",
      confidence: "verified",
    });
    expect(create!.evidence.map((e) => `${e.repo}:${e.path}:${e.line}:${e.side}`)).toEqual([
      "forge-web:src/app/customers/customer.service.ts:21:caller",
      "forge-web:src/environments/environment.ts:4:caller",
      "forge-customers:src/main/java/forge/customers/CustomerController.java:24:callee",
    ]);
    // A gRPC call that names no target joins the one entry of the estate with its name.
    expect(byId(records, "if-fc58b23d49c7c652")).toMatchObject({
      from: "customers-api",
      to: "ledger-api",
      endpoint: "ledger-api.forge-ledger-v1-ledger-openaccount",
      confidence: "verified",
    });
    // The fields that cross, and where the callee stores them.
    const maps = records
      .filter((r) => r.kind === "FieldMapping")
      .map((r) =>
        r.kind === "FieldMapping" ? `${r.interface}: ${r.sourceField} -> ${r.targetField}` : "",
      );
    expect(maps).toEqual(
      expect.arrayContaining([
        "if-0f06d434a34c81c9: firstName -> firstName",
        "if-0f06d434a34c81c9: firstName -> customers.first_name",
        "if-0f06d434a34c81c9: email -> customers.email_address",
        "if-fc58b23d49c7c652: customerId -> customer_id",
        "if-fc58b23d49c7c652: customer_id -> accounts.customer_id",
        "if-b0f886eee91a68ad: customerId -> customerId",
      ]),
    );
    // A host no repo lists stays a loose end (asked by the hosts question); two repos that could
    // answer a call leave it loose too, and say so.
    const loose = records.filter((r) => r.kind === "Unresolved").map((r) => r.id);
    expect(loose).toEqual(
      expect.arrayContaining(["unresolved.c-risk-score", "unresolved.c-get-account"]),
    );
  });

  it("gives the same catalog and flows whichever repo is written first", () => {
    const a = writeAll(REPOS);
    const b = writeAll([...REPOS].reverse());
    const c = writeAll(["forge-customers", "forge-web", "forge-ledger"]);
    expect(text(b.records)).toBe(text(a.records));
    expect(text(c.records)).toBe(text(a.records));
    for (const repo of REPOS) expect(b.flows[repo]).toEqual(a.flows[repo]);
  });

  it("writing a repo again with the same facts changes nothing", () => {
    const { records } = writeAll(REPOS);
    const again = catalogWithFacts({
      repo: "forge-customers",
      facts: factsOf("forge-customers"),
      existing: records,
      op,
      decisions: [],
      estate: all().filter((x) => x.repo !== "forge-customers"),
    });
    expect(text(again.records)).toBe(text(records));
  });

  it("points each joined call-out at the callee, so the flows join across the three repos", async () => {
    const { records, flows } = writeAll(REPOS);
    const step = flows["forge-web"]!.find((f) => f.name === "Add a customer")!.steps[1]!;
    expect(step.to).toEqual({ component: "customers-api", entry: "POST /api/customers" });
    expect(step.refs).toEqual(["if-0f06d434a34c81c9"]);
    const specs = REPOS.map((repo) => ({ repo, flows: flows[repo]! }));
    const joined = await joinEstate({ specs, records });
    expect(joined.joins.map((j) => `${j.from.flow}#${j.from.step} -> ${j.to.flow}`)).toEqual([
      "customers-api.create-a-customer#4 -> ledger-api.open-an-account",
      "web-app.add-a-customer#2 -> customers-api.create-a-customer",
      "web-app.view-a-customer#1 -> customers-api.get-a-customer",
    ]);
    const e2e = estateFlow({ flow: "web-app.add-a-customer", specs, joins: joined })!;
    expect(flattenEstateFlow(e2e).map((s) => `${s.n} ${s.repo} ${s.step.kind}`)).toEqual([
      "1 forge-web validate",
      "2 forge-web call-out",
      "2.1 forge-customers validate",
      "2.2 forge-customers call-out",
      "2.3 forge-customers write",
      "2.4 forge-customers call-out",
      "2.4.1 forge-ledger write",
      "2.4.2 forge-ledger respond",
      "2.5 forge-customers publish",
      "2.6 forge-customers respond",
      "3 forge-web respond",
    ]);
    expect(fieldLineage(e2e, "firstName").stored).toEqual({
      table: "customers-db.customers",
      column: "first_name",
    });
  });

  it("joins a flow written before its callee was read, through the Interface the callee's write made", async () => {
    // forge-customers is written with no other repo's facts: its gRPC call stays a loose end.
    const first = catalogWithFacts({
      repo: "forge-customers",
      facts: factsOf("forge-customers"),
      existing: [],
      op,
      decisions: [],
      estate: [],
    });
    const stale = first.flows.find((f) => f.name === "Create a customer")!;
    expect(stale.steps[3]!.to?.component).toBe("unresolved.c-open-account");
    // forge-ledger is read later; its write joins the call into it again.
    const second = catalogWithFacts({
      repo: "forge-ledger",
      facts: factsOf("forge-ledger"),
      existing: first.records,
      op,
      decisions: [],
      estate: [{ repo: "forge-customers", facts: factsOf("forge-customers") }],
    });
    expect(second.records.find((r) => r.id === "if-fc58b23d49c7c652")).toBeDefined();
    const joined = await joinEstate({
      specs: [
        { repo: "forge-customers", flows: first.flows },
        { repo: "forge-ledger", flows: second.flows },
      ],
      records: second.records,
    });
    expect(joined.joins.map((j) => `${j.from.flow}#${j.from.step} -> ${j.to.flow}`)).toContain(
      "customers-api.create-a-customer#4 -> ledger-api.open-an-account",
    );
  });

  it("asks which repo answers an ambiguous call, offering only the entries that could", () => {
    const { results, records } = writeAll(REPOS);
    const web = results[0]!;
    expect(web.join?.asks.map((a) => `${a.call.fact} ${a.reason}`)).toEqual([
      "c-get-account ambiguous",
    ]);
    const drafts = targetQuestionDrafts(factsOf("forge-web"), records, op, web.join?.asks);
    const q = drafts.find((d) => d.factId === "c-get-account")!;
    // The facts-targets question, as verify --write asks it (its words name the fact's repo
    // when the fact names no component, so earlier answers keep their ids).
    expect(q.draft.question).toBe(
      "Which repo or system answers GET /api/accounts/{id}, which forge-web calls?",
    );
    expect(q.draft.options.map((o) => o.label)).toEqual([
      "customers-api",
      "ledger-api",
      "northwind-risk",
      "None of these",
    ]);
  });
});

/**
 * The join fallback (ADR 0124 addendum C-join): one repo, forge-notes, holds a single-page app
 * (forge-notes-web) and its API (named after the repo). The app's calls are relative, and the
 * reader guessed `notes-service` as their target, a name that is no component.
 */
describe("a repo holding an app and its API, the app's calls relative", () => {
  const notes = (): Fact[] => {
    const r = parseFacts(readFileSync(join(ESTATE, "relative", "forge-notes.jsonl"), "utf8"));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.facts;
  };
  const write = () =>
    catalogWithFacts({
      repo: "forge-notes",
      facts: notes(),
      existing: [],
      op,
      decisions: [],
      estate: [],
    });

  it("joins the app's call to the API's entry in the same repo, inferred, and the estate join follows it", async () => {
    const out = write();
    expect(out.invalid).toEqual([]);
    expect(out.join?.joins.map((j) => [j.call.fact, j.entry.fact, j.inferred])).toEqual([
      ["c-note", "e-get-note", { within: "repo", named: "notes-service" }],
    ]);
    const iface = out.records.find(
      (r) => r.kind === "Interface" && r.from === "forge-notes-web" && r.to === "forge-notes",
    );
    expect(iface).toMatchObject({ method: "GET", endpoint: "forge-notes.get-note" });
    const open = out.flows.find((f) => f.name === "Open a note")!;
    expect(open.steps[0]!.to).toMatchObject({ component: "forge-notes" });
    const joined = await joinEstate({
      specs: [{ repo: "forge-notes", flows: out.flows }],
      records: out.records,
    });
    expect(joined.joins.map((j) => `${j.from.flow}#${j.from.step} -> ${j.to.flow}`)).toEqual([
      `${open.id}#1 -> forge-notes.get-a-note`,
    ]);
  });

  it("asks which component answers a call two of the repo's components serve, offering only those", () => {
    const out = write();
    expect(out.join?.asks.map((a) => `${a.call.fact} ${a.reason}`)).toEqual([
      "c-archive ambiguous",
    ]);
    const q = targetQuestionDrafts(notes(), out.records, op, out.join?.asks).find(
      (d) => d.factId === "c-archive",
    )!;
    expect(q.draft.question).toBe(
      "Which repo or system answers GET /api/archive/{id}, which forge-notes-web calls?",
    );
    expect(q.draft.options.map((o) => o.label).slice(0, 2)).toEqual([
      "forge-notes",
      "forge-notes-replica",
    ]);
    // The answer joins it, though the call names a target of its own.
    const answer = {
      id: q.id,
      state: "answered",
      options: q.draft.options,
      answer: { option: 2 },
      askedBy: { step: TARGETS_STEP },
    } as unknown as Question;
    const targets = targetsFromAnswers("forge-notes", notes(), [answer]);
    expect(targets).toEqual({ "c-archive": "forge-notes-replica" });
    const again = catalogWithFacts({
      repo: "forge-notes",
      facts: notes(),
      existing: [],
      op,
      decisions: [],
      estate: [],
      targets,
    });
    expect(again.join?.asks).toEqual([]);
    expect(again.join?.joins.find((j) => j.call.fact === "c-archive")).toMatchObject({
      how: "answer",
      entry: { fact: "e-get-archive-replica" },
    });
  });
});

describe("estateFacts: the other repos' facts a write joins against", () => {
  it("reads every other repo's verified facts, and leaves out one not verified yet, saying so", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-estate-facts-"));
    mkdirSync(join(root, "facts"), { recursive: true });
    cpSync(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
    for (const repo of REPOS)
      cpSync(join(ESTATE, "facts", `${repo}.jsonl`), join(root, "facts", `${repo}.jsonl`));
    const unverified = readFileSync(join(ESTATE, "facts", "forge-ledger.jsonl"), "utf8").replace(
      '"verified":"line"',
      '"verified":"none"',
    );
    writeFileSync(join(root, "facts", "forge-ledger.jsonl"), unverified);
    const got = await estateFacts(root, op, "forge-web");
    expect(got.repos.map((r) => r.repo)).toEqual(["forge-customers"]);
    expect(got.notes).toEqual([
      "forge-ledger: some of its facts aren't verified yet, so the estate join leaves them out (atticus verify forge-ledger).",
    ]);
  });
});

describe("estateFromFacts: every repo's facts at once, for the bench", () => {
  it("is the catalog and flows the writes give, with the joins and the estate's questions", () => {
    const one = writeAll(REPOS);
    const est = estateFromFacts({ op, repos: all() });
    expect(text(est.records)).toBe(text(one.records));
    expect(est.specs.map((s) => s.repo)).toEqual([...REPOS]);
    expect(est.join.joins).toHaveLength(4);
    expect(est.join.asks.map((a) => a.call.fact)).toEqual(["c-risk-score", "c-get-account"]);
  });

  it("is the golden estate the bench scorer's tests read (UPDATE_GOLDEN=1 rewrites it)", async () => {
    const est = estateFromFacts({ op, repos: all() });
    const joins = await joinEstate({ specs: est.specs, records: est.records });
    const got = stringify(
      { records: est.records, specs: est.specs, joins: joins.joins },
      { lineWidth: 0, sortMapEntries: true },
    );
    const file = join(ESTATE, "expected", "estate.yaml");
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, got);
    expect(got).toBe(readFileSync(file, "utf8"));
  });
});
