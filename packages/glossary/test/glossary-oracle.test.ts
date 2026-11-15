import { describe, expect, it } from "vitest";
import { interfaceId, type CatalogRecord } from "@maycombhq/core";
import { buildGlossary, codeTerms, fieldNames } from "../src/index.js";
import { buildGlossary as onMain } from "./oracle/build-main.js";
import {
  codeTerms as codeTermsOnMain,
  fieldNames as fieldNamesOnMain,
} from "./oracle/code-main.js";
import { fixturePages, record } from "./helpers.js";

/**
 * beta.28.2 (ADR 0195 point 9, the passes of a write): the glossary reads each record's names
 * once a build (`codeTerms` and `fieldNames` share them) and keeps the words of each name it
 * has split, and a build's glossary leaves out the naming hints (`hints: false`), which no build
 * reads. `oracle/*-main.ts` are words.ts, code.ts and build.ts as they were before (perf/b282 at
 * 941b2049, their imports pointed at src/ and at each other), kept as the oracle: over random
 * estates (endpoints, calls no endpoint stands for, tables, columns and schema fields whose
 * names share words, qualifiers and stop tokens, with aliases, definitions and column links of
 * people's), the glossary is the same terms, entries, links, conflicts, hints and problems, in
 * the same order; with `hints: false`, the same but no hints.
 */
const WORDS = ["account", "balance", "payment", "holder", "limit", "fee", "entry", "status"];
const QUAL = ["", "", "old_", "max_", "new_"];
const STOP = ["", "", "_id", "_at", "_by"];
const TYPES = ["varchar(20)", "numeric(18,2)", "timestamp", "uuid", "boolean", "text", "int"];

/** mulberry32. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function estate(seed: number): { records: CatalogRecord[]; decisions: CatalogRecord[] } {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const name = () =>
    `${pick(QUAL)}${pick(WORDS)}${rnd() < 0.5 ? `_${pick(WORDS)}` : ""}${pick(STOP)}`;
  const ev = (k: number) => [
    {
      source: "code",
      repo: `forge-repo-${k % 4}`,
      path: `src/main/java/forge/X${k}.java`,
      line: 1 + (k % 9),
    },
  ];
  const out: CatalogRecord[] = [];
  const endpoints: string[] = [];
  for (let k = 0, n = Math.floor(rnd() * 12); k < n; k++) {
    const path = `/v1/${pick(WORDS)}s/{id}/${pick(WORDS)}${rnd() < 0.3 ? "-list" : ""}`;
    const id = `svc-${k % 3}.get-${k}`;
    endpoints.push(id);
    out.push(
      record({
        kind: "Endpoint",
        id,
        confidence: "verified",
        component: `svc-${k % 3}`,
        endpointType: "rest",
        method: "GET",
        pathOrTopic: path,
        normalizedPath: path.replace(/\{id\}/g, "{}"),
        evidence: ev(k),
      }),
    );
  }
  const calls = new Set<string>();
  for (let k = 0, n = Math.floor(rnd() * 8); k < n; k++) {
    const path = `/v2/${pick(WORDS)}s/{}`;
    const to = rnd() < 0.5 && endpoints.length ? pick(endpoints) : undefined;
    const id = interfaceId(`svc-${k % 3}`, "northwind-pay", "POST", path);
    if (calls.has(id)) continue;
    calls.add(id);
    out.push(
      record({
        kind: "Interface",
        id,
        confidence: "inferred",
        from: `svc-${k % 3}`,
        to: "northwind-pay",
        ...(to ? { endpoint: to } : {}),
        via: "direct",
        method: "POST",
        normalizedPath: path,
        sync: "sync",
        ...(rnd() < 0.1 ? { status: "retired" } : {}),
        evidence: ev(k + 20),
      }),
    );
  }
  const columns: string[] = [];
  for (let t = 0, n = Math.floor(rnd() * 5); t < n; t++) {
    const tname = rnd() < 0.5 ? pick(WORDS) : `${pick(WORDS)}_${pick(WORDS)}`;
    const table = `db-${t % 2}.${tname.replace(/_/g, "-")}-${t}`;
    out.push(
      record({
        kind: "Table",
        id: table,
        confidence: "verified",
        dataStore: `db-${t % 2}`,
        name: tname,
        tableKind: "table",
        evidence: ev(t + 40),
      }),
    );
    for (let c = 0, m = 1 + Math.floor(rnd() * 5); c < m; c++) {
      const cname = name();
      const id = `${table}.${cname.replace(/_/g, "-")}-${c}`;
      columns.push(id);
      out.push(
        record({
          kind: "Column",
          id,
          confidence: "verified",
          table,
          name: cname,
          type: pick(TYPES),
          evidence: ev(t * 7 + c),
        }),
      );
    }
  }
  for (let s = 0, n = Math.floor(rnd() * 4); s < n; s++)
    out.push(
      record({
        kind: "Schema",
        id: `schema.${seed}-${s}`,
        confidence: "verified",
        format: "openapi",
        ref: `api/x.yaml#/S${s}`,
        fields: Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, f) => ({
          name: `${name().replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase())}${f}`,
          ...(rnd() < 0.8 ? { type: pick(["string", "number", "integer", "boolean"]) } : {}),
        })).filter((f, k, all) => all.findIndex((g) => g.name === f.name) === k),
        evidence: ev(s + 60),
      }),
    );
  const decisions: CatalogRecord[] = [];
  const decide = (n: number, target: string, action: string, value: unknown) =>
    decisions.push(
      record({
        kind: "CuratedDecision",
        id: `d-${seed}-${n}`,
        confidence: "asserted",
        evidence: [{ source: "manual", by: "pat" }],
        target,
        action,
        value,
        reason: "a person's",
        by: "pat",
        at: `2026-11-${String(10 + (n % 9)).padStart(2, "0")}T09:00:00Z`,
      }),
    );
  if (rnd() < 0.5) decide(1, `term.${pick(WORDS)}`, "alias", [`${pick(WORDS)} no`, "acct"]);
  if (rnd() < 0.4)
    decide(2, `term.${pick(WORDS)}`, "assert", { definition: "The amount on the account." });
  if (rnd() < 0.4 && columns.length)
    decide(3, pick(columns), "assert", { glossaryTerm: `term.${pick(WORDS)}` });
  if (rnd() < 0.3)
    decide(4, `term.${pick(WORDS)}-${pick(WORDS)}`, "assert", {
      term: "Two words",
      definition: "A date on which it happened.",
      fields: columns.slice(0, 2),
    });
  return { records: out, decisions };
}

const RUNS = 300;

describe("the glossary reads each name once and gives what it gave (beta.28.2)", () => {
  it(`${RUNS} random estates, with and without people's decisions and wiki pages`, () => {
    const pages = fixturePages();
    let linked = 0;
    let terms = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const { records, decisions } = estate(seed);
      const input = {
        pages: seed % 4 === 0 ? pages : [],
        records,
        decisions: seed % 3 === 0 ? [] : decisions,
      };
      const was = onMain(input);
      const now = buildGlossary(input);
      expect(now, `seed ${seed}`).toEqual(was);
      // Again, as a second build of the same process reads the same names.
      expect(buildGlossary(input), `seed ${seed}, again`).toEqual(was);
      expect(buildGlossary({ ...input, hints: false }), `seed ${seed}, no hints`).toEqual({
        ...was,
        hints: [],
      });
      expect([...codeTerms(records)]).toEqual([...codeTermsOnMain(records)]);
      expect(fieldNames(records)).toEqual(fieldNamesOnMain(records));
      // The same process again after one "repo" changed (the names kept are warm): a table's
      // columns renamed, an endpoint gone.
      const changed = records.flatMap((r, k): CatalogRecord[] =>
        r.kind === "Column" && r.table === records.find((x) => x.kind === "Table")?.id
          ? [{ ...r, name: `${r.name}_total` }]
          : r.kind === "Endpoint" && k % 3 === 0
            ? []
            : [r],
      );
      expect(buildGlossary({ ...input, records: changed }), `seed ${seed}, changed`).toEqual(
        onMain({ ...input, records: changed }),
      );
      if (was.columnLinks.length) linked++;
      if (was.terms.length > 2) terms++;
    }
    // The estates exercise what the glossary does: terms, and columns linked to them.
    expect(terms).toBeGreaterThan(RUNS / 2);
    expect(linked).toBeGreaterThan(RUNS / 4);
  }, 120_000);

  it("a word list it keeps is never one a caller can change", async () => {
    const { businessWords } = await import("../src/words.js");
    const a = businessWords("old_accountHolders");
    a.push("changed");
    expect(businessWords("old_accountHolders")).toEqual(["old", "account", "holder"]);
  });
});
