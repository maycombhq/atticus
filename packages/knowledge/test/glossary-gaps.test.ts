import { describe, expect, it } from "vitest";
import {
  abbreviates,
  glossaryTermKnown,
  KNOWLEDGE_CHECKS,
  knowledgeGaps,
  namingHint,
} from "../src/index.js";
import { forgePack, forgeRecords, record } from "./helpers.js";

const ev = (path: string, line: number) => [
  { source: "migration", repo: "forge-ledger", path, line },
];

/** Forge plus a planned table and column (as a Spec Kit plan puts them in the catalog). */
const planned = () => [
  ...forgeRecords(),
  record({
    kind: "Column",
    id: "ledger-db.account.daily-limit",
    status: "planned-new",
    confidence: "inferred",
    table: "ledger-db.account",
    name: "daily_limit",
    type: "numeric(18,2)",
    evidence: ev("src/main/resources/db/migration/V3__add_daily_limit.sql", 1),
  }),
  record({
    kind: "Table",
    id: "ledger-db.limit-change",
    status: "planned-new",
    confidence: "inferred",
    dataStore: "ledger-db",
    name: "limit_change",
    tableKind: "table",
    evidence: ev("src/main/resources/db/migration/V4__create_limit_change.sql", 1),
  }),
  record({
    kind: "Column",
    id: "ledger-db.limit-change.account-id",
    status: "planned-new",
    confidence: "inferred",
    table: "ledger-db.limit-change",
    name: "account_id",
    type: "bigint",
    evidence: ev("src/main/resources/db/migration/V4__create_limit_change.sql", 2),
  }),
  record({
    kind: "Column",
    id: "ledger-db.limit-change.holder-nm",
    status: "planned-new",
    confidence: "inferred",
    table: "ledger-db.limit-change",
    name: "holder_nm",
    type: "varchar(200)",
    evidence: ev("src/main/resources/db/migration/V4__create_limit_change.sql", 3),
  }),
];

const terms = () => [
  record({
    kind: "GlossaryTerm",
    id: "term.account",
    confidence: "inferred",
    term: "Account",
    definition: "A customer's ledger account.",
    evidence: [{ source: "document", path: "inputs/wiki/ledger-glossary.md", line: 8 }],
  }),
  record({
    kind: "GlossaryTerm",
    id: "term.holder-name",
    confidence: "inferred",
    term: "Holder name",
    definition: "The name of the person who owns the account.",
    evidence: [{ source: "document", path: "inputs/wiki/ledger-glossary.md", line: 16 }],
  }),
];

describe("glossary-term-known (new columns and fields need a term)", () => {
  it("is a built-in check, before the feature checks, saying what it needs", () => {
    const ids = KNOWLEDGE_CHECKS.map((c) => c.id);
    expect(ids.indexOf("glossary-term-known")).toBe(3);
    expect(glossaryTermKnown.needs.map((n) => n.kind)).toEqual(["GlossaryTerm", "Column"]);
  });

  it("raises nothing on Forge as scanned: no column is new", async () => {
    const gaps = knowledgeGaps({ records: forgeRecords(), orgPack: await forgePack() });
    expect(gaps.filter((g) => g.check === "glossary-term-known")).toEqual([]);
  });

  it("asks the owning component's system about new fields without a term, with naming hints", async () => {
    const gaps = knowledgeGaps({
      records: [...planned(), ...terms()],
      orgPack: await forgePack(),
    }).filter((g) => g.check === "glossary-term-known");
    expect(
      gaps.map((g) => ({
        system: g.system,
        owner: g.owner,
        records: g.records,
        id: g.question.id,
        question: g.question.question,
        neededFact: g.question.neededFact,
      })),
    ).toEqual([
      {
        system: "ledger",
        owner: "team-ledger",
        records: ["ledger-api"],
        id: "q.glossary-term-known.ledger-api",
        question:
          "Which business terms do the new fields of ledger-api hold (ledger-db.account.daily-limit, ledger-db.limit-change.holder-nm)? Define each in the glossary or link it to a term. holder_nm looks like Holder name (term.holder-name); name it holder_name or link it to that term.",
        neededFact:
          "GlossaryTerm for ledger-db.account.daily-limit, ledger-db.limit-change.holder-nm",
      },
    ]);
  });

  it("is satisfied by a link on the column, a term's fields, or a term with the name", async () => {
    const records = [
      ...planned().map((r) =>
        r.id === "ledger-db.account.daily-limit"
          ? record({ ...r, glossaryTerm: "term.daily-limit" })
          : r,
      ),
      ...terms().map((t) =>
        t.id === "term.holder-name"
          ? record({ ...t, fields: ["ledger-db.limit-change.holder-nm"] })
          : t,
      ),
      record({
        kind: "GlossaryTerm",
        id: "term.daily-limit",
        confidence: "asserted",
        term: "Daily limit",
        definition: "The most an account can send in one day.",
        evidence: [{ source: "manual", by: "pat" }],
      }),
    ];
    const gaps = knowledgeGaps({ records, orgPack: await forgePack() });
    expect(gaps.filter((g) => g.check === "glossary-term-known")).toEqual([]);
  });

  it("says when a column links to a term the glossary doesn't have", async () => {
    const records = planned().map((r) =>
      r.id === "ledger-db.account.daily-limit"
        ? record({ ...r, glossaryTerm: "term.day-limit" })
        : r.id === "ledger-db.limit-change.holder-nm"
          ? record({ ...r, glossaryTerm: "term.day-limit" })
          : r,
    );
    const [gap] = knowledgeGaps({ records, orgPack: await forgePack() }).filter(
      (g) => g.check === "glossary-term-known",
    );
    expect(gap!.question.question).toContain(
      "ledger-db.account.daily-limit links to term.day-limit, which isn't in the glossary.",
    );
  });
});

describe("naming hints", () => {
  const names = [
    { id: "term.account-number", term: "Account number", aliases: ["Acct ref"] },
    { id: "term.holder-name", term: "Holder name" },
  ];

  it("spots abbreviations of every word of a term", () => {
    expect(abbreviates("acct", "account")).toBe(true);
    expect(abbreviates("no", "number")).toBe(true);
    expect(abbreviates("nm", "name")).toBe(true);
    expect(abbreviates("amount", "account")).toBe(false);
    expect(namingHint("t.acct-no", "acct_no", names)).toMatchObject({
      term: "term.account-number",
      kind: "abbreviation",
    });
  });

  it("spots another name of a term, and stays quiet for the term's own name", () => {
    expect(namingHint("t.acct-ref", "acctRef", names)).toMatchObject({
      term: "term.account-number",
      kind: "alias",
      message:
        'acctRef uses "Acct ref", another name for Account number (term.account-number); name it account_number or keep it linked.',
    });
    expect(namingHint("t.account-number", "account_number", names)).toBeUndefined();
    expect(namingHint("t.status", "status", names)).toBeUndefined();
  });
});
