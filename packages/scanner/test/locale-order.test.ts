import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOrgPack,
  parseFacts,
  parseRecord,
  serializeRecord,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { catalogWithFacts, estateRepos, mergeEstate } from "../src/index.js";

// Review round 47: the catalog a repo's facts make is the same bytes in every locale and
// whatever order the facts come in (localeCompare ordered `_`/`-`, and `aa` in Danish, by locale).
const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const meta = join(fixtures, "metarepo");

const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const first = r.facts[0]!;
  const extra = ["aa_timeout", "aa-timeout", "zeta.timeout", "aarhus.url"].map(
    (key, i) =>
      ({
        kind: "config",
        id: `k-r47-${i}`,
        repo: first.repo,
        commit: first.commit,
        component: "ledger-api",
        settingKind: "config",
        key,
        value: String(i),
        cite: { file: "src/main/resources/application.yml", line: 40 + i, value: key },
        verified: "line",
        by: "assistant",
        conf: "declared",
      }) as unknown as Fact,
  );
  return [...r.facts, ...extra];
};

let op: OrgPack;
let before: CatalogRecord[];
beforeAll(async () => {
  op = await loadOrgPack(join(meta, "org-pack"));
  const raw = (parse(readFileSync(join(meta, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  before = mergeEstate(op, estateRepos(op), raw).records;
});

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

describe("catalogWithFacts in different locales (round 47)", () => {
  it("writes the same records, in the same order, in en and da", () => {
    const text = (fs: Fact[]) => {
      const out = catalogWithFacts({
        repo: "forge-ledger",
        facts: fs,
        existing: before,
        op,
        decisions: [],
      });
      expect(out.invalid).toEqual([]);
      return out.records.map(serializeRecord).join("---\n");
    };
    inLocale("en");
    const en = text(facts());
    inLocale("da");
    const da = text([...facts()].reverse());
    expect(da).toBe(en);
    const ids = en
      .split("\n")
      .filter((l) => l.startsWith("id: ledger-api.aa"))
      .map((l) => l.slice(4));
    expect(ids).toEqual([
      "ledger-api.aa-timeout",
      "ledger-api.aa_timeout",
      "ledger-api.aarhus.url",
    ]);
  });
});
