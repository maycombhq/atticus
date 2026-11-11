import { describe, expect, it } from "vitest";
import {
  auditPrecision,
  canaryRate,
  foldCanary,
  latestCanaries,
  parseCanaryReport,
  plantedBy,
  removedBy,
  scoreCanary,
  serializeCanaryReport,
  silentErrorRate,
  type AuditItemT,
  type CanaryKeyT,
  type Fact,
} from "../src/index.js";

/**
 * Canaries (plan item Z2, ADR 0196): scoring a read of a planted copy against its key, and the
 * silent error rate pooled with the sample audit's answers. Invented Forge names throughout.
 */

const KEY: Pick<CanaryKeyT, "repo" | "commit" | "seed" | "stacks" | "planted" | "removed"> = {
  repo: "forge-portal-bff",
  commit: "b0b0001",
  seed: "s1",
  stacks: ["spring"],
  planted: [
    {
      id: "plant:1",
      kind: "entry",
      what: "entry",
      stack: "spring",
      file: "src/main/java/forge/portal/HeronQuartzResource.java",
      line: 16,
      claim: "entry GET /heron-quartz/{id}",
      needle: "heron-quartz",
    },
    {
      id: "plant:2",
      kind: "config",
      what: "config",
      stack: "spring",
      file: "src/main/resources/application.yml",
      line: 10,
      claim: "config birch.reed-url",
      needle: "birch-reed-url",
    },
  ],
  removed: [
    {
      id: "remove:call.post.transfers",
      fact: "call.post.transfers",
      kind: "call",
      file: "src/main/java/forge/portal/LedgerClient.java",
      line: 11,
      claim: "call POST /ledger/v1/transfers",
      value: "/transfers",
      needle: "ledger-v1-transfers",
      how: "commented",
    },
  ],
};

const fact = (x: Record<string, unknown>): Fact =>
  ({
    repo: "forge-portal-bff",
    commit: "b0b0001",
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...x,
  }) as unknown as Fact;

const plantedEntry = fact({
  kind: "entry",
  id: "entry.get.heron-quartz-id",
  entryType: "rest",
  method: "GET",
  path: "/heron-quartz/{id}",
  cite: {
    file: "src/main/java/forge/portal/HeronQuartzResource.java",
    line: 16,
    value: "/heron-quartz/{id}",
    quote: '@GetMapping("/heron-quartz/{id}")',
  },
});
const plantedConfig = fact({
  kind: "config",
  id: "config.birch-reed-url",
  settingKind: "config",
  key: "birch.reed-url",
  value: "https://birch-reed.example",
  cite: {
    file: "src/main/resources/application.yml",
    line: 10,
    value: "reed-url",
    quote: "reed-url: https://birch-reed.example",
  },
});
const fabricated = fact({
  kind: "call",
  id: "call.post.transfers",
  callType: "rest",
  method: "POST",
  path: "/ledger/v1/transfers",
  cite: {
    file: "src/main/java/forge/portal/LedgerClient.java",
    line: 11,
    value: "/transfers",
    quote: '// @PostMapping("/transfers")',
  },
});
const AT = { at: "2026-11-11T10:00:00.000Z", by: "tom" };

describe("scoreCanary", () => {
  it("a read that finds every planted item and claims nothing removed is perfect", () => {
    const r = scoreCanary(KEY, { kept: [plantedEntry, plantedConfig], rejected: [] }, AT);
    expect(r.recall).toEqual({ k: 2, n: 2, rate: 1, low: 0.342, high: 1 });
    expect(r.fabrication).toEqual({ k: 0, n: 1, rate: 0, low: 0, high: 0.793 });
    expect(r.passed).toEqual(r.fabrication);
    expect(r.planted.map((p) => [p.result, p.by])).toEqual([
      ["found", "entry.get.heron-quartz-id"],
      ["found", "config.birch-reed-url"],
    ]);
    expect(r.removed.map((x) => x.result)).toEqual(["absent"]);
    expect(r.read).toEqual({ facts: 2, kept: 2, rejected: 0 });
    // The key's needles stay on this machine: never in the report.
    expect(JSON.stringify(r)).not.toContain("needle");
  });

  it("a missed plant lowers recall; a removed line still claimed and kept is a fabrication", () => {
    const r = scoreCanary(KEY, { kept: [plantedEntry, fabricated], rejected: [] }, AT);
    expect(r.recall.k).toBe(1);
    expect(r.recall.rate).toBe(0.5);
    expect(r.planted.map((p) => p.result)).toEqual(["found", "missed"]);
    expect(r.fabrication).toMatchObject({ k: 1, n: 1, rate: 1 });
    expect(r.passed).toMatchObject({ k: 1, n: 1, rate: 1 });
    expect(r.removed[0]).toMatchObject({ result: "kept", by: "call.post.transfers" });
  });

  it("a claim the verifier rejected is no find and no silent fabrication", () => {
    const r = scoreCanary(KEY, { kept: [], rejected: [plantedConfig, fabricated] }, AT);
    expect(r.planted.map((p) => p.result)).toEqual(["missed", "rejected"]);
    expect(r.removed[0]!.result).toBe("rejected");
    expect(r.recall.k).toBe(0);
    // the reader fabricated it; the verifier caught it, so it passed as nothing
    expect(r.fabrication.k).toBe(1);
    expect(r.passed.k).toBe(0);
  });

  it("matches a plant by its kind and its own words, whatever the spelling or line", () => {
    const env = fact({
      kind: "config",
      id: "config.birch",
      key: "BIRCH_REED_URL",
      cite: { file: "x.py", line: 1, value: "BIRCH_REED_URL", quote: "" },
    });
    expect(plantedBy(KEY.planted[1]!, env)).toBe(true);
    // the same words under another kind are something else
    expect(plantedBy(KEY.planted[0]!, { ...plantedEntry, kind: "call" } as Fact)).toBe(false);
    expect(foldCanary("Birch.Reed-URL")).toBe("birch-reed-url");
  });

  it("matches a removed fact by its path or key anywhere, or by its value beside its line", () => {
    const r = KEY.removed[0]!;
    const at = (line: number, x: Record<string, unknown> = {}) =>
      ({ ...fabricated, ...x, cite: { ...fabricated.cite, line } }) as Fact;
    expect(removedBy(r, at(12))).toBe(true);
    // the same path cited on another line (a constant, another file) still claims it
    expect(removedBy(r, at(40))).toBe(true);
    expect(removedBy(r, at(40, { path: "/ledger/v1/transfers/{id}" }))).toBe(false);
    // only the value, away from the line: something else
    expect(removedBy(r, at(13, { path: "/transfers" }))).toBe(false);
    expect(removedBy(r, at(11, { path: "/transfers" }))).toBe(true);
  });

  it("round-trips its report file and keeps the latest of each repo", () => {
    const r = scoreCanary(KEY, { kept: [plantedEntry], rejected: [] }, AT);
    const back = parseCanaryReport(serializeCanaryReport(r));
    expect(back).toEqual({ ok: true, report: r });
    expect(parseCanaryReport("schema: 2\n").ok).toBe(false);
    const later = { ...r, at: "2026-11-12T10:00:00.000Z" };
    expect(latestCanaries([later, r])).toEqual([later]);
  });
});

describe("silentErrorRate", () => {
  const item = (id: string, kind: "fact" | "link", of: string, answer: AuditItemT["answer"]) =>
    ({ id, kind, of, claim: id, cites: ["a:1"], ...(answer ? { answer } : {}) }) as AuditItemT;

  it("pools the audit's wrong backed claims with the canaries' kept fabrications", () => {
    const audit = auditPrecision([
      ...Array.from({ length: 9 }, (_, i) => item(`fact:f${i}`, "fact", "entry", "right")),
      item("fact:bad", "fact", "call", "wrong"),
      item("link:a", "link", "joined-by-host", "right"),
      // A guessed link is graded inferred, never backed: its wrong answer is no silent error.
      item("link:b", "link", "joined-by-path", "wrong"),
      item("fact:u", "fact", "entry", "unsure"),
    ]);
    const canary = scoreCanary(
      KEY,
      { kept: [plantedEntry, plantedConfig, fabricated], rejected: [] },
      AT,
    );
    const s = silentErrorRate({ precision: audit, repos: 1 }, [canary]);
    // audit: 1 wrong of 11 backed answered (10 facts + 1 host-joined link)
    expect(s.misread).toEqual(canaryRate(1, 11));
    // canary: 2 planted found (right) + 1 removed kept (wrong)
    expect(s.recall).toEqual(canaryRate(2, 2));
    expect(s.fabrication).toEqual(canaryRate(1, 1));
    expect(s.passed).toEqual(canaryRate(1, 1));
    expect(s.silent).toEqual(canaryRate(2, 14));
    expect(s.repos).toEqual({ audited: 1, canaries: 1 });
  });

  it("is not measured with nothing on file", () => {
    const s = silentErrorRate(undefined, []);
    expect(s.silent).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
    expect(s.repos).toEqual({ audited: 0, canaries: 0 });
  });

  it("counts a fabrication the verifier refused as caught, apart", () => {
    const canary = scoreCanary(KEY, { kept: [plantedEntry], rejected: [fabricated] }, AT);
    const s = silentErrorRate(undefined, [canary]);
    expect(s.caught).toBe(1);
    expect(s.fabrication).toEqual(canaryRate(1, 1));
    expect(s.passed).toEqual(canaryRate(0, 1));
    expect(s.silent).toEqual(canaryRate(0, 1));
  });
});
