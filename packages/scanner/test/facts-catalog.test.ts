import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOrgPack,
  parseFacts,
  parseRecord,
  serializeRecord,
  type CatalogRecord,
  type Fact,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  estateRepos,
  mergeEstate,
  readCatalog,
  targetQuestionFor,
  targetQuestionDrafts,
  targetsFromAnswers,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * Facts into the catalog (ADR 0124, A3b): a repo's verified facts replace the records a reader
 * made from that repo, every other repo's records stay as they were, and the same merge,
 * identity and curated-decision passes a scan runs give the catalog.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const meta = join(fixtures, "metarepo");

const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const raw = (): CatalogRecord[] =>
  (parse(readFileSync(join(meta, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    // A scan's raw records: every one current, at the catalog's schema version.
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });

let op: OrgPack;
let before: CatalogRecord[];
let decisions: CatalogRecord[];
beforeAll(async () => {
  op = await loadOrgPack(join(meta, "org-pack"));
  // The catalog as a scan wrote it: the raw records through the estate's merge.
  before = mergeEstate(op, estateRepos(op), raw()).records;
  const curated = await readCatalog(join(meta, "catalog", "curated"));
  if (curated.problems.length) throw new Error(JSON.stringify(curated.problems));
  decisions = curated.records;
});

const fromRepo = (r: CatalogRecord, repo: string) =>
  r.evidence.some((e) => (e as { repo?: string }).repo === repo);

describe("catalogWithFacts: a repo's verified facts written into the catalog", () => {
  it("replaces what came from the repo and leaves every other repo's records as they were", () => {
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    expect(out.invalid).toEqual([]);
    const notifyBefore = before.filter(
      (r) => fromRepo(r, "forge-notify") && !fromRepo(r, "forge-ledger"),
    );
    expect(notifyBefore.length).toBeGreaterThan(3);
    for (const r of notifyBefore) {
      const now = out.records.find((x) => x.kind === r.kind && x.id === r.id);
      expect(now, `${r.kind} ${r.id}`).toBeDefined();
      expect(serializeRecord(now!)).toBe(serializeRecord(r));
    }
    // The reader's endpoint the facts don't have is gone; the facts' endpoints are there.
    const eps = out.records.filter((r) => r.kind === "Endpoint" && fromRepo(r, "forge-ledger"));
    expect(eps.map((e) => e.id).sort()).toEqual([
      "ledger-api.get-account",
      "ledger-api.on-forge-payments-settled",
      "ledger-api.post-entry",
    ]);
    for (const e of eps)
      for (const ev of e.evidence) expect((ev as { by?: string }).by).toBe("assistant");
    expect(out.records.some((r) => r.id === "ledger-api.delete-account")).toBe(false);
    // Nothing in the catalog is a Flow: flows live in specs/<repo>/ (ADR 0079).
    expect(out.records.some((r) => r.kind === "Flow")).toBe(false);
  });

  it("keeps another repo's call into this one, re-joined to the endpoint the facts name", () => {
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    const call = out.records.find(
      (r) => r.kind === "Interface" && r.from === "notify-api" && r.to === "ledger-api",
    ) as Extract<CatalogRecord, { kind: "Interface" }>;
    expect(call).toBeDefined();
    expect(call.endpoint).toBe("ledger-api.get-account");
    const sides = call.evidence.map((e) => `${e.repo}:${e.side}:${e.by ?? "reader"}`).sort();
    expect(sides).toEqual(["forge-ledger:callee:assistant", "forge-notify:caller:reader"]);
  });

  it("names endpoints the way a scan does, and follows the new ids into schemas and flows", () => {
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    const schema = out.records.find((r) => r.kind === "Schema" && r.id.startsWith("ledger-api."))!;
    expect(schema.id).toBe("ledger-api.post-entry.request");
    expect((schema as { ref: string }).ref).toBe("ledger-api.post-entry");
    const post = out.records.find((r) => r.id === "ledger-api.post-entry") as {
      schemaRefs: string[];
    };
    expect(post.schemaRefs).toEqual(["ledger-api.post-entry.request"]);
    expect(out.flows.map((f) => f.id)).toEqual(["ledger-api.post-a-ledger-entry"]);
    const flow = out.flows[0]!;
    expect(flow.trigger.ref).toBe("ledger-api.post-entry");
    expect(flow.steps[0]!.refs).toEqual(["ledger-api.post-entry.request"]);
    // Every id a flow names is in the catalog.
    const ids = new Set(out.records.map((r) => r.id));
    for (const s of flow.steps) for (const ref of s.refs) expect(ids.has(ref), ref).toBe(true);
  });

  it("applies a person's curated decisions over the projected records, and says which no longer apply", () => {
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    const amount = out.records.find((r) => r.id === "ledger-db.entry.amount") as {
      classification?: string;
      confidence: string;
    };
    expect(amount.classification).toBe("confidential");
    expect(amount.confidence).toBe("asserted");
    expect(out.curated.applied).toContain("cd-classify-entry-amount");
    expect(out.curated.problems.map((p) => p.decision)).toEqual(["cd-assert-delete-account"]);
  });

  it("makes a call to a host a loose end the hosts question can ask about (ADR 0088)", () => {
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    const loose = out.records.find(
      (r) =>
        r.kind === "Unresolved" && r.owner === "ledger-api" && r.unresolvedKind === "http-call",
    ) as { raw: string; id: string };
    expect(loose.raw).toBe("POST http://notify.internal/notify");
    expect(out.unresolved.map((u) => u.factId)).toEqual(["c-notify"]);
  });

  it("joins the call once the repo that answers on the host is listed", () => {
    const op2: OrgPack = {
      ...op,
      profiles: op.profiles.map((p) => ({
        ...p,
        repos: p.repos && {
          ...p.repos,
          repos: p.repos.repos.map((r) =>
            r.id === "forge-notify" ? { ...r, hosts: ["notify.internal"] } : r,
          ),
        },
      })),
    };
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op: op2,
      decisions,
    });
    const call = out.records.find(
      (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
    ) as { endpoint?: string };
    expect(call?.endpoint).toBe("notify-api.post-notify");
    expect(out.unresolved).toEqual([]);
  });

  it("is deterministic: the same facts, catalog and decisions give the same bytes", () => {
    const a = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    const b = catalogWithFacts({
      repo: "forge-ledger",
      facts: [...facts()].reverse(),
      existing: [...before].reverse(),
      op,
      decisions,
    });
    expect(a.records.map(serializeRecord)).toEqual(b.records.map(serializeRecord));
    expect(a.flows.map(serializeRecord)).toEqual(b.flows.map(serializeRecord));
  });

  it("writing the same facts again changes nothing", () => {
    const once = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: before,
      op,
      decisions,
    });
    const twice = catalogWithFacts({
      repo: "forge-ledger",
      facts: facts(),
      existing: once.records,
      op,
      decisions,
    });
    expect(twice.records.map(serializeRecord)).toEqual(once.records.map(serializeRecord));
  });
});

describe("a call with no target and no host becomes a question (ADR 0078)", () => {
  const noHost = () =>
    facts().map((f) => (f.id === "c-notify" && f.kind === "call" ? { ...f, host: undefined } : f));

  it("asks which repo or system answers it, with the components that serve that kind of call", () => {
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: noHost(),
      existing: before,
      op,
      decisions,
    });
    expect(out.unresolved.map((u) => u.factId)).toEqual(["c-notify"]);
    const drafts = targetQuestionDrafts(noHost(), out.records, op);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.factId).toBe("c-notify");
    expect(d.draft.question).toBe(
      "Which repo or system answers POST /notify, which ledger-api calls?",
    );
    expect(d.draft.evidence).toEqual(["src/main/java/forge/ledger/Notifier.java:9"]);
    expect(d.draft.options.map((o) => o.label)).toEqual([
      "notify-api",
      "northwind-fx",
      "None of these",
    ]);
    expect(targetQuestionFor(noHost().find((f) => f.id === "c-notify")!)?.question).toBe(
      d.draft.question,
    );
  });

  it("reads the answer back as the call's target on the next write", () => {
    const drafts = targetQuestionDrafts(noHost(), before, op);
    const q = {
      id: drafts[0]!.id,
      state: "answered",
      options: drafts[0]!.draft.options,
      answer: { option: 1 },
      askedBy: { step: TARGETS_STEP },
    } as unknown as Question;
    expect(targetsFromAnswers("forge-ledger", noHost(), [q])).toEqual({ "c-notify": "notify-api" });
    const out = catalogWithFacts({
      repo: "forge-ledger",
      facts: noHost(),
      existing: before,
      op,
      decisions,
      targets: targetsFromAnswers("forge-ledger", noHost(), [q]),
    });
    expect(
      out.records.some(
        (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
      ),
    ).toBe(true);
    const none = {
      ...q,
      answer: { option: drafts[0]!.draft.options.length },
    } as unknown as Question;
    expect(targetsFromAnswers("forge-ledger", noHost(), [none])).toEqual({});
  });
});
