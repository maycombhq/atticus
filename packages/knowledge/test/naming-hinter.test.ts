import { describe, expect, it } from "vitest";
import { NAME_ABBREVIATIONS, namingHint, namingHinter, type TermName } from "../src/index.js";

/**
 * beta.28.4 (the owner's field report: one repo's Apply took over ten minutes on a 40-repo
 * estate): `namingHint` reads every term for each name, and a build's glossary asked it once per
 * compound term, so its time grew with the square of the estate's vocabulary. `namingHinter`
 * reads the terms once and answers each name from what it kept. `namingHint` is unchanged and is
 * the oracle here: over random term lists (names that repeat, shorten or abbreviate one another,
 * aliases, a term left out as the build leaves out the name's own), the same hint or none.
 */

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

const FULL = ["account", "number", "holder", "name", "balance", "amount", "limit", "accounts"];
const SHORT = ["acct", "acc", "no", "num", "hldr", "nm", "bal", "amt", "lmt", "an", "a", "id"];
const JOIN = ["_", " ", "-", ""];

function lists(seed: number): { terms: TermName[]; names: string[] } {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const word = () => (rnd() < 0.6 ? pick(FULL) : pick(SHORT));
  const name = () => {
    const n = 1 + Math.floor(rnd() * 3);
    const j = pick(JOIN);
    const ws = Array.from({ length: n }, word);
    return j === ""
      ? ws.map((w, k) => (k ? w[0]!.toUpperCase() + w.slice(1) : w)).join("")
      : ws.join(j);
  };
  const terms: TermName[] = Array.from({ length: Math.floor(rnd() * 14) }, (_, k) => ({
    id: `term.t-${k}`,
    term: rnd() < 0.1 ? "id" : name(),
    ...(rnd() < 0.3 ? { aliases: Array.from({ length: 1 + Math.floor(rnd() * 2) }, name) } : {}),
  }));
  return { terms, names: [...Array.from({ length: 12 }, name), "", "id", "__"] };
}

describe("namingHinter answers as namingHint does (beta.28.4)", () => {
  it("over 2,000 random lists of terms, with and without one term left out", () => {
    let hints = 0;
    let abbreviations = 0;
    let aliases = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const { terms, names } = lists(seed);
      const hint = namingHinter(terms);
      for (const [k, n] of names.entries()) {
        const was = namingHint(`r-${k}`, n, terms);
        expect(hint(`r-${k}`, n), `seed ${seed}, ${n}`).toEqual(was);
        if (was) hints++;
        if (was?.kind === "abbreviation") abbreviations++;
        if (was?.kind === "alias") aliases++;
        // As a build's glossary asks: every term but the name's own.
        for (const t of terms.slice(0, 3))
          expect(hint(t.id, n, t.id), `seed ${seed}, ${n} without ${t.id}`).toEqual(
            namingHint(
              t.id,
              n,
              terms.filter((x) => x.id !== t.id),
            ),
          );
      }
      // A term's own name, with the term left out and not.
      for (const t of terms) {
        expect(hint(t.id, t.term, t.id)).toEqual(
          namingHint(
            t.id,
            t.term,
            terms.filter((x) => x.id !== t.id),
          ),
        );
        expect(hint(t.id, t.term)).toEqual(namingHint(t.id, t.term, terms));
      }
    }
    // The lists exercise each answer.
    expect(abbreviations).toBeGreaterThan(500);
    expect(aliases).toBeGreaterThan(500);
    expect(hints).toBeLessThan(2000 * 15);
  });

  it("over 3,000 wider lists: ids that repeat, a term that is its own alias, every way a name is written", () => {
    // The review of beta.28.4: upper case and camel case, digits, letters outside ASCII, every
    // separator, the names of Object's own members as words, two terms with one id, a term whose
    // alias is its own name, and `except` as any id, one no term has, and "".
    const WORDS = [
      ...FULL,
      ...SHORT,
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
      "ACCT",
      "AccountNo",
      "acct2",
      "2nd",
      "3",
      "konto",
      "kontó",
      "größe",
      "名前",
      "of",
      "the",
      "ids",
    ];
    const SEPS = ["_", " ", "-", ".", "/", "__", " - ", ":", ""];
    let hints = 0;
    let odd = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const rnd = prng(seed * 7919);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const name = () => {
        const sep = pick(SEPS);
        const ws = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(WORDS));
        const joined =
          sep === ""
            ? ws.map((w, k) => (k ? w[0]!.toUpperCase() + w.slice(1) : w)).join("")
            : ws.join(sep);
        return rnd() < 0.15 ? joined.toUpperCase() : joined;
      };
      const terms: TermName[] = Array.from({ length: Math.floor(rnd() * 12) }, (_, k) => {
        const term = name();
        return {
          // Some ids twice.
          id: `term.t-${rnd() < 0.25 ? Math.floor(rnd() * 3) : k}`,
          term,
          ...(rnd() < 0.4
            ? {
                aliases: [
                  ...(rnd() < 0.3 ? [term] : []),
                  ...Array.from({ length: Math.floor(rnd() * 3) }, name),
                ],
              }
            : {}),
        };
      });
      const hint = namingHinter(terms);
      const names = [...Array.from({ length: 10 }, name), ...terms.map((t) => t.term), "", "_"];
      const excepts = [undefined, "", "term.none", ...terms.map((t) => t.id)];
      for (const [k, n] of names.entries())
        for (const except of excepts) {
          const was = namingHint(
            `r-${k}`,
            n,
            except === undefined ? terms : terms.filter((t) => t.id !== except),
          );
          expect(hint(`r-${k}`, n, except), `seed ${seed}, ${n}, except ${except}`).toEqual(was);
          if (was) hints++;
          if (was && /constructor|tostring|proto|[à-ÿ名]|\d/i.test(n)) odd++;
        }
    }
    expect(hints).toBeGreaterThan(3000);
    expect(odd).toBeGreaterThan(100);
  }, 120_000);

  it("finds a listed abbreviation whose first letter is not its word's", () => {
    // None of today's list is one; the search by first letters must not rest on that.
    const table = NAME_ABBREVIATIONS as Record<string, string>;
    table.xfer = "transfer";
    try {
      const terms = [{ id: "term.transfer-amount", term: "Transfer amount" }];
      const was = namingHint("c.1", "xfer_amt", terms);
      expect(was?.kind).toBe("abbreviation");
      expect(namingHinter(terms)("c.1", "xfer_amt")).toEqual(was);
    } finally {
      delete table.xfer;
    }
  });

  it("answers 8,000 names against 8,000 terms without reading every term for each", () => {
    const SYL = ["ba", "ren", "tok", "mi", "sul", "dar", "vex", "lo", "pim", "gar"];
    const word = (n: number) => SYL[n % 10]! + SYL[Math.floor(n / 10) % 10]! + SYL[n % 7]!;
    const terms = Array.from({ length: 8000 }, (_, k) => ({
      id: `term.t-${k}`,
      term: `${word(k % 97)} ${word(100 + Math.floor(k / 97))}`,
    }));
    const c = process.cpuUsage();
    const hint = namingHinter(terms);
    let found = 0;
    for (const t of terms) if (hint(t.id, t.term.replace(" ", "_"), t.id)) found++;
    const s = (process.cpuUsage(c).user + process.cpuUsage(c).system) / 1e6;
    console.log(`naming-hinter 8,000 names against 8,000 terms: ${s.toFixed(2)} CPU s`);
    // namingHint for each takes about 70 CPU s here; this about 0.1. A slow runner passes.
    expect(s).toBeLessThan(10);
    expect(found).toBeLessThan(8000);
  }, 120_000);
});
