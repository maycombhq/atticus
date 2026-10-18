import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, ReplayRuntime } from "@maycombhq/ai";
import { readPage } from "@maycombhq/knowledge";
import {
  aliasDecision,
  buildGlossary,
  defineDecision,
  GlossaryError,
  linkDecision,
  loadGlossary,
  pageDefinitions,
  parseDefinerOutput,
  proposeDefinitions,
  readRecords,
  scanGlossary,
  undefinedCodeTerms,
  writeDecisions,
  type GlossaryTermRecord,
} from "../src/index.js";
import {
  decisions,
  extraRecords,
  FIXTURES,
  forgePages,
  forgeRecords,
  metarepo,
} from "./helpers.js";

const page = (content: string, path = "inputs/wiki/p.md") =>
  readPage({ source: "w", path, content });

describe("definitions from wiki pages", () => {
  it("reads every markup on a glossary page, with lines", () => {
    const defs = pageDefinitions(
      page(
        [
          "# Payments glossary", // 1
          "", // 2
          "Owner: Payments team", // 3
          "Settlement: Moving money between banks at the end of the day.", // 4
          "", // 5
          "- Chargeback — A card payment the customer's bank takes back.", // 6
          "- **Payee**: Who receives a payment.", // 7
          "", // 8
          "| Name | Meaning |", // 9
          "| --- | --- |", // 10
          "| Cut-off | The last time a payment can go out today. |", // 11
          "", // 12
          "## Value date", // 13
          "", // 14
          "The day the money is available to the payee.", // 15
        ].join("\n"),
      ),
    );
    expect(defs.map((d) => [d.term, d.line, d.markup, d.definition])).toEqual([
      ["Settlement", 4, "line", "Moving money between banks at the end of the day."],
      ["Chargeback", 6, "list", "A card payment the customer's bank takes back."],
      ["Payee", 7, "bold", "Who receives a payment."],
      ["Cut-off", 11, "table", "The last time a payment can go out today."],
      ["Value date", 15, "heading", "The day the money is available to the payee."],
    ]);
  });

  it("reads only explicit markup elsewhere, and a glossary section of any page", () => {
    const defs = pageDefinitions(
      page(
        [
          "# Ledger service", // 1
          "", // 2
          "Owner: Ledger team", // 3
          "Service level: 99.9% monthly availability.", // 4
          "", // 5
          "**Posting**: Writing an entry to the ledger.", // 6
          "", // 7
          "Hold", // 8
          ": Money set aside for a pending transfer.", // 9
          "", // 10
          "## Terms", // 11
          "", // 12
          "Cut-off: The last time a transfer can post today.", // 13
          "", // 14
          "## Runbook", // 15
          "", // 16
          "Restart: Use the console.", // 17
        ].join("\n"),
      ),
    );
    expect(defs.map((d) => [d.term, d.line, d.markup])).toEqual([
      ["Posting", 6, "bold"],
      ["Hold", 8, "definition-list"],
      ["Cut-off", 13, "line"],
    ]);
  });

  it("finds nothing on the Forge pages: their colon lines are metadata and facts", () => {
    expect(forgePages().flatMap(pageDefinitions)).toEqual([]);
  });
});

describe("AI definitions for code-only terms (replay)", () => {
  const entries = () =>
    undefinedCodeTerms(buildGlossary({ pages: forgePages(), records: forgeRecords() }).entries);

  it("proposes only for terms with no page or person definition, citing their usages", async () => {
    const runtime = await ReplayRuntime.fromDir(join(FIXTURES, "recordings"));
    const r = await proposeDefinitions(entries(), runtime, {
      now: new Date("2026-10-18T09:00:00Z"),
    });
    expect(r.waiting).toBeUndefined();
    expect(r.proposals.map((p) => [p.term, p.definition, p.evidence])).toEqual([
      [
        "term.balance",
        "How much money an account holds, as the portal shows it to the customer.",
        ["ledger-api.get-balance", "portal-bff.get-balance"],
      ],
      [
        "term.transfer",
        "Money a customer moves out of an account through the portal.",
        ["ledger-api.post-transfer"],
      ],
    ]);
    expect(r.discarded).toEqual([
      { term: "term.entry", reason: "it cites no record that uses the term" },
      { term: "term.unknown", reason: "term.unknown isn't one of the terms it was given" },
    ]);
  });

  it("discards an answer that isn't YAML or has no terms", () => {
    expect(
      parseDefinerOutput("terms: [", entries(), { agent: "a", at: "2026-10-18T09:00:00Z" })
        .discarded[0]!.reason,
    ).toMatch(/not YAML/);
    expect(
      parseDefinerOutput("features: []", entries(), { agent: "a", at: "2026-10-18T09:00:00Z" })
        .discarded,
    ).toEqual([{ reason: "the output has no terms list" }]);
  });
});

describe("decisions", () => {
  it("define, alias and link make curated decisions; bad input is refused", async () => {
    const d = defineDecision("daily limits", "The most an account can send in a day.", {
      by: "pat",
      at: "2026-10-18T09:00:00Z",
    });
    expect(d).toMatchObject({
      id: "glossary.define.daily-limit",
      target: "term.daily-limit",
      action: "assert",
      value: { term: "Daily limits", definition: "The most an account can send in a day." },
    });
    expect(
      aliasDecision("term.account-number", ["Acct no", "acct no ", "Account no"], { by: "bao" })
        .value,
    ).toEqual(["Account no", "Acct no"]);
    expect(() => defineDecision("x", "", { by: "pat" })).toThrow(GlossaryError);
    expect(() => defineDecision("x", "A thing.", { by: " " })).toThrow(/Say who decides/);

    const records = [...forgeRecords(), ...extraRecords()];
    const term = buildGlossary({ pages: [], records }).terms.find(
      (t) => t.id === "term.account-number",
    )! as GlossaryTermRecord;
    expect(
      linkDecision(term, "reports-db.daily-total.acct-no", records, {
        by: "bao",
        at: "2026-10-18T09:00:00Z",
      }),
    ).toMatchObject({
      id: "glossary.link.reports-db.daily-total.acct-no",
      target: "reports-db.daily-total.acct-no",
      value: { glossaryTerm: "term.account-number" },
    });
    expect(linkDecision(term, "ledger-api.post-transfer", records, { by: "bao" })).toMatchObject({
      id: "glossary.fields.account-number",
      target: "term.account-number",
      value: {
        fields: ["ledger-api.post-transfer", "ledger-db.account.account-number"],
      },
    });
    expect(() => linkDecision(term, "nope", records, { by: "bao" })).toThrow(/no record nope/);
    expect(() =>
      linkDecision(term, "ledger-api.post-transfer#amount", records, { by: "bao" }),
    ).toThrow(/has no schema field/);
  });
});

describe("the glossary in a metarepo", () => {
  it("scan writes the terms and column links into catalog/generated, idempotently", async () => {
    const root = await metarepo({ extra: extraRecords(), pages: true, decisions: decisions() });
    const r = await scanGlossary(root);
    expect(r.problems).toEqual([]);
    expect(r.written).toEqual([
      "column/ledger-db.account.account-number.yaml",
      "column/ledger-db.account.daily-limit.yaml",
      "column/ledger-db.account.holder-name.yaml",
      "column/ledger-db.entry.account-id.yaml",
      "column/reports-db.daily-total.acct-no.yaml",
      "column/reports-db.daily-total.daily-limit.yaml",
      "glossaryterm/term.account-number.yaml",
      "glossaryterm/term.account.yaml",
      "glossaryterm/term.balance.yaml",
      "glossaryterm/term.daily-limit.yaml",
      "glossaryterm/term.daily-total.yaml",
      "glossaryterm/term.entry.yaml",
      "glossaryterm/term.holder-name.yaml",
      "glossaryterm/term.payment.yaml",
      "glossaryterm/term.remaining-limit.yaml",
      "glossaryterm/term.transfer.yaml",
    ]);
    const cat = await readRecords(join(root, "catalog/generated"));
    expect(cat.problems).toEqual([]);
    const col = cat.records.find((c) => c.id === "reports-db.daily-total.acct-no");
    expect(col).toMatchObject({ glossaryTerm: "term.account-number" });
    const rl = cat.records.find((c) => c.id === "term.remaining-limit");
    expect(rl).toMatchObject({ confidence: "asserted" });
    const again = await scanGlossary(root);
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
  });

  it("define and link decisions show on the next build; a dropped term's file and links go", async () => {
    const root = await metarepo({ extra: extraRecords(), pages: true });
    await scanGlossary(root);
    const g = await loadGlossary(root);
    const term = g.terms.find((t) => t.id === "term.daily-total")!;
    await writeDecisions(join(root, "catalog/curated"), [
      defineDecision("term.daily-total", "What the reports job adds up per account and day.", {
        by: "pat",
        at: "2026-10-18T09:00:00Z",
        existing: term,
      }),
      linkDecision(term, "reports-db.daily-total.holder-nm", g.base, {
        by: "pat",
        at: "2026-10-18T09:00:00Z",
      }),
    ]);
    const r = await scanGlossary(root);
    const dt = r.terms.find((t) => t.id === "term.daily-total")!;
    expect(dt).toMatchObject({
      term: "Daily total",
      definition: "What the reports job adds up per account and day.",
      confidence: "asserted",
      fields: ["reports-db.daily-total.holder-nm"],
    });
    expect(dt.flags ?? []).toEqual([]);
    const text = await readFile(
      join(root, "catalog/generated/column/reports-db.daily-total.holder-nm.yaml"),
      "utf8",
    );
    expect((parse(text) as { glossaryTerm?: string }).glossaryTerm).toBe("term.daily-total");
  });

  it("asks the definer only when given a runtime, and saves its proposals", async () => {
    const root = await metarepo();
    const runtime = new MockRuntime(
      () =>
        "terms:\n  - id: term.entry\n    definition: One posting to an account.\n    evidence: [ledger-db.entry]\n",
    );
    const r = await scanGlossary(root, { runtime, now: new Date("2026-10-18T09:00:00Z") });
    expect(r.propose?.proposals.map((p) => p.term)).toEqual(["term.entry"]);
    const entry = r.terms.find((t) => t.id === "term.entry")!;
    expect(entry).toMatchObject({
      definition: "One posting to an account.",
      flags: ["ai-proposed"],
    });
    const saved = parse(
      await readFile(join(root, "catalog/proposals/glossaryterm/term.entry.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({ term: "term.entry", agent: "glossary-definer" });
  });
});
