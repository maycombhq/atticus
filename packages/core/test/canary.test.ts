import { describe, expect, it } from "vitest";
import {
  auditPrecision,
  CanaryKey,
  canaryRate,
  canaryRunRepo,
  isCanaryRepoName,
  isCanaryRunName,
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
    expect(r.planted.map((p) => p.result)).toEqual(["found", "found"]);
    expect(r.removed.map((x) => x.result)).toEqual(["absent"]);
    expect(r.read).toEqual({ facts: 2, kept: 2, rejected: 0, unread: 0 });
    // The key's needles stay on this machine: never in the report.
    expect(JSON.stringify(r)).not.toContain("needle");
  });

  it("keeps a planted item's words, file and line out of the report: kind, stack and result only", () => {
    const r = scoreCanary(
      { ...KEY, skipped: [{ stack: "spring", what: "topic-in", reason: "no Kafka client" }] },
      { kept: [plantedEntry], rejected: [], unread: 2 },
      AT,
    );
    expect(r.planted).toEqual([
      { id: "plant:1", kind: "entry", what: "entry", stack: "spring", result: "found" },
      { id: "plant:2", kind: "config", what: "config", stack: "spring", result: "missed" },
    ]);
    expect(r.skipped).toEqual([{ stack: "spring", what: "topic-in", reason: "no Kafka client" }]);
    expect(r.read.unread).toBe(2);
    const text = serializeCanaryReport(r);
    for (const w of ["heron", "quartz", "birch", "reed", "HeronQuartzResource", "application.yml"])
      expect(text).not.toContain(w);
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

  it("a fact naming a removed path but cited elsewhere is counted apart, never as passed", () => {
    const elsewhere = {
      ...fabricated,
      cite: { ...fabricated.cite, file: "src/main/java/forge/portal/TransferRoutes.java", line: 4 },
    } as Fact;
    const r = scoreCanary(KEY, { kept: [elsewhere], rejected: [] }, AT);
    expect(r.removed[0]).toMatchObject({ result: "elsewhere", by: "call.post.transfers" });
    expect(r.passed).toMatchObject({ k: 0, n: 0 });
    expect(r.fabrication).toMatchObject({ k: 0, n: 0 });
    // a cite.with part beside the commented line puts it there
    const byPart = {
      ...elsewhere,
      cite: {
        ...elsewhere.cite,
        with: [
          { file: "src/main/java/forge/portal/LedgerClient.java", line: 12, value: "/ledger" },
        ],
      },
    } as Fact;
    expect(scoreCanary(KEY, { kept: [byPart], rejected: [] }, AT).removed[0]!.result).toBe("kept");
  });

  it("one fact answers for one item at most", () => {
    const twin: CanaryKeyT["planted"][number] = { ...KEY.planted[0]!, id: "plant:3", line: 30 };
    const r = scoreCanary(
      { ...KEY, planted: [KEY.planted[0]!, twin] },
      {
        kept: [plantedEntry],
        rejected: [],
      },
      AT,
    );
    expect(r.planted.map((p) => p.result)).toEqual(["found", "missed"]);
    // and a fact taken by a plant isn't taken again by a removed line
    const both = fact({
      ...fabricated,
      id: "call.both",
    } as unknown as Record<string, unknown>);
    const k2 = {
      ...KEY,
      planted: [
        {
          ...KEY.planted[0]!,
          kind: "call" as const,
          what: "call" as const,
          needle: "ledger-v1-transfers",
        },
      ],
    };
    const r2 = scoreCanary(k2, { kept: [both], rejected: [] }, AT);
    expect(r2.planted[0]!.result).toBe("found");
    expect(r2.removed[0]!.result).toBe("absent");
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

  it("matches a removed fact beside its line by path, key or value; the path alone elsewhere", () => {
    const r = KEY.removed[0]!;
    const at = (line: number, x: Record<string, unknown> = {}) =>
      ({ ...fabricated, ...x, cite: { ...fabricated.cite, line } }) as Fact;
    expect(removedBy(r, at(12))).toBe("near");
    // the same path cited on another line (a constant, another file) may be about that line
    expect(removedBy(r, at(40))).toBe("elsewhere");
    expect(removedBy(r, at(40, { path: "/ledger/v1/transfers/{id}" }))).toBe(undefined);
    // only the value, away from the line: something else
    expect(removedBy(r, at(13, { path: "/transfers" }))).toBe(undefined);
    expect(removedBy(r, at(11, { path: "/transfers" }))).toBe("near");
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

describe("canary names", () => {
  it("takes a repo name only of plain characters, never one that climbs out", () => {
    for (const ok of ["forge-portal-bff", "forge.ledger", "Forge_2"])
      expect(isCanaryRepoName(ok)).toBe(true);
    for (const bad of ["", "../victim", "a/b", "a\\b", "..", "a..b", "-x", ".x", "a b", "a:b"])
      expect(isCanaryRepoName(bad), bad).toBe(false);
  });

  it("knows a run folder by its name, and a key that names another folder doesn't read", () => {
    expect(isCanaryRunName("atticus-canary-forge-portal-bff-a1B2c3", "forge-portal-bff")).toBe(
      true,
    );
    expect(canaryRunRepo("atticus-canary-forge-portal-bff-a1B2c3")).toBe("forge-portal-bff");
    for (const bad of [
      "atticus-canary-forge-portal-bff-a1B2c",
      "atticus-canary-forge-portal-bff-a1B2c3/..",
      "atticus-canary-precious",
      "../atticus-canary-forge-portal-bff-a1B2c3",
    ])
      expect(isCanaryRunName(bad, "forge-portal-bff"), bad).toBe(false);
    // a longer repo's run folder is not a shorter one's
    expect(isCanaryRunName("atticus-canary-forge-portal-bff-a1B2c3", "forge-portal")).toBe(false);
    const key = {
      schema: 1,
      repo: "forge-portal-bff",
      seed: "s1",
      run: "atticus-canary-forge-portal-bff-a1B2c3",
      stacks: [],
      planted: [],
      removed: [],
      at: AT.at,
    };
    expect(CanaryKey.safeParse(key).success).toBe(true);
    for (const run of [
      "/tmp/victim/atticus-canary-precious",
      "../../victim",
      "/tmp/atticus-canary-forge-portal-bff-a1B2c3",
    ])
      expect(CanaryKey.safeParse({ ...key, run }).success, run).toBe(false);
    expect(CanaryKey.safeParse({ ...key, repo: "../../victim/package" }).success).toBe(false);
  });
});

describe("silentErrorRate", () => {
  const item = (id: string, kind: "fact" | "link", of: string, answer: AuditItemT["answer"]) =>
    ({ id, kind, of, claim: id, cites: ["a:1"], ...(answer ? { answer } : {}) }) as AuditItemT;

  it("gives the audit misread rate and the canary pass-through rate side by side, never pooled", () => {
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
    // canary: 1 removed line of 1 claimed and kept; the found plants are no part of it
    expect(s.passed).toEqual(canaryRate(1, 1));
    expect(s.recall).toEqual(canaryRate(2, 2));
    expect(s.fabrication).toEqual(canaryRate(1, 1));
    expect(s).not.toHaveProperty("silent");
    expect(s.repos).toEqual({ audited: 1, canaries: 1 });
    expect(s.covers).toEqual([{ stack: "spring", what: ["entry", "config"] }]);
  });

  it("is not measured with nothing on file", () => {
    const s = silentErrorRate(undefined, []);
    expect(s.misread).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
    expect(s.passed).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
    expect(s.repos).toEqual({ audited: 0, canaries: 0 });
    expect(s.covers).toEqual([]);
  });

  it("counts a fabrication the verifier refused as caught, and one named elsewhere apart", () => {
    const canary = scoreCanary(KEY, { kept: [plantedEntry], rejected: [fabricated] }, AT);
    const s = silentErrorRate(undefined, [canary]);
    expect(s.caught).toBe(1);
    expect(s.fabrication).toEqual(canaryRate(1, 1));
    expect(s.passed).toEqual(canaryRate(0, 1));
    const away = { ...fabricated, cite: { ...fabricated.cite, line: 40 } } as Fact;
    const e = silentErrorRate(undefined, [scoreCanary(KEY, { kept: [away], rejected: [] }, AT)]);
    expect(e.elsewhere).toBe(1);
    expect(e.passed).toEqual(canaryRate(0, 0));
  });
});
