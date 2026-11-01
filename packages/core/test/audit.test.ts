import { describe, expect, it } from "vitest";
import {
  auditCandidates,
  auditPrecision,
  drawAudit,
  mergeDraw,
  parseAuditFile,
  serializeAuditFile,
  wilson,
  type AuditFileT,
  type AuditItemT,
  type Fact,
} from "../src/index.js";

/**
 * P3, the sample audit: a person confirms a handful of random facts and links per repo, and the
 * precision is said with the sample size and a plain interval, so it is honest about how small
 * the sample is. Pure: the draw is reproducible from its seed.
 */

const fact = (id: string, kind: "entry" | "call" | "store", extra: Partial<Fact> = {}): Fact =>
  ({
    id,
    repo: "forge-payments",
    commit: "c3c0006",
    cite: { file: `src/${id}.java`, line: 3, value: `/${id}` },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...(kind === "entry"
      ? { kind, entryType: "rest", method: "GET", path: `/${id}` }
      : kind === "call"
        ? { kind, callType: "rest", method: "POST", path: `/${id}` }
        : { kind, store: "payments-db", name: id, op: "write" }),
    ...extra,
  }) as Fact;

const FACTS: Fact[] = [
  ...Array.from({ length: 12 }, (_, i) => fact(`e${String(i).padStart(2, "0")}`, "entry")),
  ...Array.from({ length: 5 }, (_, i) => fact(`c${i}`, "call")),
  fact("s0", "store"),
  fact("mine", "entry", { by: "person", verified: "person" }),
  fact("open", "entry", { verified: "none" }),
];

const LINKS = Array.from({ length: 6 }, (_, i) => ({
  id: `link:c${i}`,
  kind: "link" as const,
  of: i % 2 ? "joined-by-host" : "joined-by-path",
  claim: `forge-payments POST /c${i} -> forge-accounts POST /c${i}`,
  cites: [`forge-payments src/c${i}.java:3`, `forge-accounts src/A.java:${i + 1}`],
  fact: `c${i}`,
  to: "forge-accounts",
}));

describe("auditCandidates", () => {
  it("takes the kept facts a reader wrote, never a person's own or an unchecked one", () => {
    const c = auditCandidates(FACTS);
    expect(c.map((x) => x.id)).not.toContain("fact:mine");
    expect(c.map((x) => x.id)).not.toContain("fact:open");
    expect(c).toHaveLength(18);
    expect(c.find((x) => x.id === "fact:e00")).toEqual({
      id: "fact:e00",
      kind: "fact",
      of: "entry",
      claim: "entry GET /e00",
      cites: ["src/e00.java:3"],
      fact: "e00",
      value: "/e00",
    });
  });
});

describe("drawAudit", () => {
  it("is reproducible: the same seed draws the same items, another seed others", () => {
    const a = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 5, seed: "s1" });
    const b = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 5, seed: "s1" });
    const c = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 5, seed: "s2" });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a.map((x) => x.id)).not.toEqual(c.map((x) => x.id));
    expect(a.filter((x) => x.kind === "fact")).toHaveLength(5);
    expect(a.filter((x) => x.kind === "link")).toHaveLength(5);
  });

  it("does not depend on the order the facts come in", () => {
    const fwd = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 4, seed: "x" });
    const rev = drawAudit({
      facts: auditCandidates([...FACTS].reverse()),
      links: [...LINKS].reverse(),
      size: 4,
      seed: "x",
    });
    expect(rev.map((x) => x.id).sort()).toEqual(fwd.map((x) => x.id).sort());
  });

  it("takes them all when there are fewer than the size", () => {
    const d = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 50, seed: "s" });
    expect(d.filter((x) => x.kind === "fact")).toHaveLength(18);
    expect(d.filter((x) => x.kind === "link")).toHaveLength(6);
  });
});

describe("mergeDraw", () => {
  it("keeps the answers on file and adds only what is new; the same draw adds nothing", () => {
    const items = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 3, seed: "s" });
    const first = mergeDraw(undefined, "forge-payments", items, {
      seed: "s",
      size: 3,
      commit: "c3c0006",
      at: "2026-10-31T10:00:00.000Z",
    });
    first.items[0]!.answer = "right";
    const again = mergeDraw(first, "forge-payments", items, {
      seed: "s",
      size: 3,
      commit: "c3c0006",
      at: "2026-10-31T11:00:00.000Z",
    });
    expect(again.items).toHaveLength(6);
    expect(again.items[0]!.answer).toBe("right");
    expect(again.draws).toHaveLength(1);
    const more = drawAudit({ facts: auditCandidates(FACTS), links: LINKS, size: 3, seed: "t" });
    const third = mergeDraw(again, "forge-payments", more, {
      seed: "t",
      size: 3,
      commit: "c3c0006",
      at: "2026-10-31T12:00:00.000Z",
    });
    expect(third.draws.map((d) => d.seed)).toEqual(["s", "t"]);
    expect(new Set(third.items.map((i) => i.id)).size).toBe(third.items.length);
    expect(third.items.length).toBeGreaterThan(6);
  });
});

describe("wilson", () => {
  it("gives a plain 95% interval that is wide on a small sample and narrows on a big one", () => {
    expect(wilson(9, 10)).toEqual({ low: 0.596, high: 0.982 });
    expect(wilson(90, 100)).toEqual({ low: 0.826, high: 0.945 });
    expect(wilson(0, 0)).toBeUndefined();
    expect(wilson(5, 5)?.high).toBe(1);
  });
});

describe("auditPrecision", () => {
  const items: AuditItemT[] = [
    { id: "fact:a", kind: "fact", of: "entry", claim: "x", cites: ["a:1"], answer: "right" },
    { id: "fact:b", kind: "fact", of: "entry", claim: "x", cites: ["a:1"], answer: "wrong" },
    { id: "fact:c", kind: "fact", of: "call", claim: "x", cites: ["a:1"], answer: "right" },
    { id: "fact:d", kind: "fact", of: "call", claim: "x", cites: ["a:1"], answer: "unsure" },
    { id: "fact:e", kind: "fact", of: "store", claim: "x", cites: ["a:1"] },
    {
      id: "link:a",
      kind: "link",
      of: "joined-by-host",
      claim: "x",
      cites: ["r a:1"],
      answer: "right",
    },
    {
      id: "link:b",
      kind: "link",
      of: "joined-by-path",
      claim: "x",
      cites: ["r a:1"],
      answer: "wrong",
    },
  ];
  it("counts right over right and wrong, per kind and for links; unsure and open apart", () => {
    const p = auditPrecision(items);
    expect(p.facts).toMatchObject({
      drawn: 5,
      right: 2,
      wrong: 1,
      unsure: 1,
      open: 1,
      precision: 0.667,
    });
    expect(p.facts.low).toBeLessThan(0.3);
    expect(p.byKind.entry).toMatchObject({ drawn: 2, right: 1, wrong: 1, precision: 0.5 });
    expect(p.byKind.call).toMatchObject({ right: 1, unsure: 1, precision: 1 });
    expect(p.byKind.store).toMatchObject({ drawn: 1, open: 1, precision: null });
    expect(p.links).toMatchObject({ drawn: 2, right: 1, wrong: 1, precision: 0.5 });
    expect(p.byHow["joined-by-path"]).toMatchObject({ wrong: 1, precision: 0 });
  });
  it("leaves out the items a keep test drops (a fact read again since)", () => {
    const p = auditPrecision(items, (i) => i.id !== "fact:b");
    expect(p.facts).toMatchObject({ right: 2, wrong: 0, precision: 1, gone: 1 });
  });
});

describe("the audit file", () => {
  it("reads back what it writes, and says what is wrong with a bad one", () => {
    const file: AuditFileT = {
      schema: 1,
      repo: "forge-payments",
      draws: [{ seed: "s", size: 3, commit: "c3c0006", at: "2026-10-31T10:00:00.000Z" }],
      items: [
        {
          id: "fact:a",
          kind: "fact",
          of: "entry",
          claim: "entry GET /a",
          cites: ["src/A.java:3"],
          fact: "a",
          answer: "wrong",
          by: "tom",
          at: "2026-10-31T10:01:00.000Z",
          note: "It is a POST",
        },
      ],
    };
    const text = serializeAuditFile(file);
    expect(parseAuditFile(text)).toEqual({ ok: true, file });
    const bad = parseAuditFile(
      "schema: 1\nrepo: x\ndraws: []\nitems:\n  - { id: a, answer: maybe }\n",
    );
    expect(bad.ok).toBe(false);
  });
});
