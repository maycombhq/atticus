import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifyCommand } from "../src/verify-commands.js";

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");

/** A repo adopted in place: `.atticus/org-pack/` present, facts under `.atticus/facts/`. */
function adoptedRepo(facts: string): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-verify-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
  writeFileSync(join(root, ".atticus", "facts", "forge-ledger.jsonl"), facts);
  return root;
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus verify <repo> (ADR 0124)", () => {
  it("keeps a correct read, writes the report, exits 0", async () => {
    const root = adoptedRepo(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
    const o = io();
    const code = await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, o.io);
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    expect(o.out[0]).toMatch(/17 facts kept, 0 rejected; coverage \d+%/);
    const report = parse(
      readFileSync(join(root, ".atticus", "facts", "forge-ledger.verify.yaml"), "utf8"),
    );
    expect(report.accepted).toBe(17);
    expect(existsSync(join(root, ".atticus", "facts", "forge-ledger.rejected.jsonl"))).toBe(false);
    const kept = readFileSync(join(root, ".atticus", "facts", "forge-ledger.jsonl"), "utf8");
    expect(kept.trim().split("\n")).toHaveLength(17);
    expect(kept).toContain('"verified":"line"');
  });

  it("lists the entries no flow follows in the report and the summary, a note that doesn't fail the run (C-estate)", async () => {
    const root = adoptedRepo(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
    const o = io();
    const code = await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, o.io);
    expect(code).toBe(0);
    const report = parse(
      readFileSync(join(root, ".atticus", "facts", "forge-ledger.verify.yaml"), "utf8"),
    );
    // e-post-entry starts w-post-entry; the account read and the settlement listener have no flow.
    expect(report.entriesNoFlowFollows).toEqual([
      {
        id: "e-get-account",
        entryType: "rest",
        method: "GET",
        path: "/accounts/{accountId}",
        cite: "src/main/java/forge/ledger/AccountController.java:18",
      },
      {
        id: "e-settle-listener",
        entryType: "event-topic",
        path: "forge.payments.settled",
        cite: "src/main/java/forge/ledger/SettlementListener.java:14",
      },
    ]);
    const text = o.out.join("\n");
    expect(text).toMatch(/2 entries no flow follows/);
    expect(text).toContain("GET /accounts/{accountId}");
    expect(text).toContain("event-topic forge.payments.settled");
  });

  it("writes the rejected facts with their reasons and exits 1, so the reading loop goes again", async () => {
    const both =
      readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8") +
      readFileSync(join(fixtures, "redteam.facts.jsonl"), "utf8");
    const root = adoptedRepo(both);
    const o = io();
    const code = await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, o.io);
    expect(code).toBe(1);
    expect(o.out[0]).toMatch(/17 facts kept, 11 rejected/);
    const rejected = readFileSync(
      join(root, ".atticus", "facts", "forge-ledger.rejected.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { code: string });
    expect(rejected).toHaveLength(11);
    expect(o.out.join("\n")).toMatch(/run atticus verify forge-ledger again/);
  });

  it("says what to run when there are no facts yet, or they don't parse", async () => {
    const root = adoptedRepo("");
    const o = io();
    expect(await verifyCommand(root, "other", {}, o.io)).toBe(2);
    expect(o.err[0]).toMatch(/Run \/atticus-map other/);
    writeFileSync(join(root, ".atticus", "facts", "bad.jsonl"), "{not json}\n");
    const p = io();
    expect(await verifyCommand(root, "bad", {}, p.io)).toBe(2);
    expect(p.err.join("\n")).toMatch(/line 1/);
  });

  it("raises the questions the reader wrote beside the facts, each evidence line checked (ADR 0078)", async () => {
    const root = adoptedRepo(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
    const good = {
      question: "Is notify.internal the production host of the notifier, or a test stand-in?",
      options: [
        { label: "Production", means: "it is the real host", changes: "the call goes to it" },
        { label: "Stand-in", means: "a test double", changes: "the call is left unresolved" },
      ],
      evidence: ["src/main/java/forge/ledger/Notifier.java:9"],
    };
    const bad = { question: "Is this used?", evidence: ["src/Nowhere.java:3"] };
    writeFileSync(
      join(root, ".atticus", "facts", "forge-ledger.questions.jsonl"),
      `${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`,
    );
    const o = io();
    const code = await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, o.io);
    expect(code).toBe(1);
    const questions = readdirSync(join(root, ".atticus", "questions"));
    expect(questions).toHaveLength(1);
    const q = parse(readFileSync(join(root, ".atticus", "questions", questions[0]!), "utf8"));
    expect(q.question).toBe(good.question);
    expect(q.askedBy.step).toBe("map");
    expect(q.rerun).toBe("atticus map forge-ledger");
    const rejected = readFileSync(
      join(root, ".atticus", "facts", "forge-ledger.rejected.jsonl"),
      "utf8",
    );
    expect(rejected).toContain('"code":"bad-question"');
    expect(rejected).toContain("src/Nowhere.java:3 is no line of the repo");
    expect(o.out.join("\n")).toMatch(
      /1 question raised for a person now, 1 refused \(of 2 lines in \.atticus\/facts\/forge-ledger\.questions\.jsonl\)/,
    );
    // Asked again by the next verify: the same question, the same file, and still counted.
    const p = io();
    await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, p.io);
    expect(readdirSync(join(root, ".atticus", "questions"))).toHaveLength(1);
    expect(p.out.join("\n")).toMatch(/0 questions raised for a person now, 1 raised before/);
    expect(p.out.join("\n")).toMatch(/1 question open for forge-ledger/);
  });
});

/**
 * Every list verify prints is summarised (A-big2): a count, the first few, and where the whole
 * list is. A real read printed 221 entries without an authCite on one line. The repo is an
 * invented Forge gates service with many routes, read with no authCite and no flow.
 */
describe("atticus verify: long lists are counted, shown in part and pointed to (A-big2)", () => {
  const N = 12;
  const CTRL = "src/main/java/forge/gates/GateController.java";
  const gates = () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-verify-gates-"));
    mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
    mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
    mkdirSync(join(root, "src", "main", "java", "forge", "gates"), { recursive: true });
    const lines = [
      "package forge.gates;",
      "",
      "import org.springframework.web.bind.annotation.*;",
      "",
      "@RestController",
      '@RequestMapping("/gates")',
      "public class GateController {",
      ...Array.from({ length: N }, (_, i) => [
        `  @GetMapping("/g${i}")`,
        `  public String g${i}() { return "open"; }`,
      ]).flat(),
      "}",
    ];
    writeFileSync(join(root, CTRL), lines.join("\n") + "\n");
    // line 8 + 2i holds route i
    const entry = (i: number, value = `/g${i}`) =>
      JSON.stringify({
        kind: "entry",
        id: `e-g${i}`,
        repo: "forge-gates",
        commit: "6a7e5c0",
        component: "gates-api",
        entryType: "rest",
        method: "GET",
        path: `/gates${value}`,
        handler: `GateController.g${i}`,
        auth: "oauth2",
        cite: {
          file: CTRL,
          line: 8 + 2 * i,
          value,
          quote: `@GetMapping("/g${i}")`,
          with: [{ file: CTRL, line: 6, value: "/gates" }],
        },
      });
    const facts = Array.from({ length: N }, (_, i) => entry(i));
    return { root, facts, entry };
  };
  const question = (i: number) =>
    JSON.stringify({
      question: `Is gate g${i} served to the public, or only inside the Forge network?`,
      options: [
        { label: "Public", means: "anyone can call it", changes: "it is an edge route" },
        { label: "Internal", means: "only Forge services", changes: "it is an internal route" },
      ],
      evidence: [`${CTRL}:${8 + 2 * i}`],
    });
  const longest = (out: string[]) => Math.max(...out.map((l) => l.length));

  it("counts the entries whose auth was left out, shows the first five, and points to verify.yaml", async () => {
    const { root, facts } = gates();
    writeFileSync(join(root, ".atticus", "facts", "forge-gates.jsonl"), facts.join("\n") + "\n");
    const o = io();
    expect(await verifyCommand(root, "forge-gates", { commit: "6a7e5c0" }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(text).toMatch(
      /12 entries' auth rests on no cited line \(all under authUncited in \.atticus\/facts\/forge-gates\.verify\.yaml\)\./,
    );
    // A-uncited: it says what is kept where, and what to do, not only that something is amiss.
    expect(text).toContain("kept in .atticus/facts/forge-gates.jsonl");
    expect(text).toContain("left out of the catalog");
    expect(text).toMatch(/give each entry an authCite/);
    const shown = o.out.filter((l) => /^ {2}e-g\d+ \(oauth2, /.test(l));
    expect(shown).toHaveLength(5);
    expect(shown[0]).toBe(`  e-g0 (oauth2, ${CTRL}:8)`);
    expect(text).toMatch(
      /\.\.\. and 7 more \(authUncited in \.atticus\/facts\/forge-gates\.verify\.yaml\)/,
    );
    // the entries no flow follows, the same way
    expect(text).toMatch(/12 entries no flow follows/);
    expect(o.out.filter((l) => /^ {2}GET \/gates\/g\d+ \(e-g\d+, /.test(l))).toHaveLength(5);
    expect(text).toMatch(
      /\.\.\. and 7 more \(entriesNoFlowFollows in \.atticus\/facts\/forge-gates\.verify\.yaml\)/,
    );
    expect(longest(o.out)).toBeLessThan(1_000);
    const report = parse(
      readFileSync(join(root, ".atticus", "facts", "forge-gates.verify.yaml"), "utf8"),
    );
    expect(report.authUncited).toHaveLength(N);
  });

  it("counts the rejected facts and the lines that aren't facts, the first five of each, and points to rejected.jsonl", async () => {
    const { root, facts, entry } = gates();
    // a route no line has: rejected
    const wrong = Array.from({ length: 8 }, (_, i) =>
      entry(i, `/nowhere${i}`).replace(`"e-g${i}"`, `"e-x${i}"`),
    );
    const junk = Array.from({ length: 7 }, (_, i) =>
      JSON.stringify({ kind: "entry", id: `e-bad${i}` }),
    );
    writeFileSync(
      join(root, ".atticus", "facts", "forge-gates.jsonl"),
      [...facts, ...wrong, ...junk].join("\n") + "\n",
    );
    const o = io();
    expect(await verifyCommand(root, "forge-gates", { commit: "6a7e5c0" }, o.io)).toBe(1);
    const text = o.out.join("\n");
    expect(o.out.filter((l) => /^ {2}claim-not-on-line: /.test(l))).toHaveLength(5);
    expect(text).toMatch(
      /\.\.\. and 3 more rejected \(all in \.atticus\/facts\/forge-gates\.rejected\.jsonl\)/,
    );
    expect(o.out.filter((l) => /^ {2}schema: /.test(l))).toHaveLength(5);
    expect(text).toMatch(
      /\.\.\. and 2 more lines that aren't facts \(all in \.atticus\/facts\/forge-gates\.rejected\.jsonl\)/,
    );
    expect(longest(o.out)).toBeLessThan(1_000);
  });

  it("raises every question the reader wrote, says how many are open, and shows the first five", async () => {
    const { root, facts } = gates();
    writeFileSync(join(root, ".atticus", "facts", "forge-gates.jsonl"), facts.join("\n") + "\n");
    const bad = Array.from({ length: 7 }, (_, i) =>
      JSON.stringify({ question: `Is g${i} used?`, evidence: [`src/Nowhere${i}.java:3`] }),
    );
    writeFileSync(
      join(root, ".atticus", "facts", "forge-gates.questions.jsonl"),
      [...Array.from({ length: N }, (_, i) => question(i)), ...bad].join("\n") + "\n",
    );
    const o = io();
    expect(await verifyCommand(root, "forge-gates", { commit: "6a7e5c0" }, o.io)).toBe(1);
    // none held back: every one is a file in questions/
    expect(readdirSync(join(root, ".atticus", "questions"))).toHaveLength(N);
    const text = o.out.join("\n");
    expect(text).toMatch(
      /12 questions raised for a person now, 7 refused \(of 19 lines in \.atticus\/facts\/forge-gates\.questions\.jsonl\)/,
    );
    expect(text).toMatch(
      /12 questions open for forge-gates, waiting for a person's answer \(atticus questions list --state open lists them all; a person answers, never the assistant\):/,
    );
    expect(o.out.filter((l) => /^ {2}q-[0-9a-f]{12}: Is gate g\d+ served/.test(l))).toHaveLength(5);
    expect(text).toMatch(/\.\.\. and 7 more open/);
    expect(o.out.filter((l) => /^ {2}bad-question: /.test(l))).toHaveLength(5);
    expect(text).toMatch(
      /\.\.\. and 2 more refused questions \(all in \.atticus\/facts\/forge-gates\.rejected\.jsonl\)/,
    );
    const j = io();
    await verifyCommand(root, "forge-gates", { commit: "6a7e5c0", json: true }, j.io);
    const r = JSON.parse(j.out.join("\n"));
    expect(r.questions).toMatchObject({ lines: 19, raised: 0, known: N, refused: 7, open: N });
  });
});

/**
 * What six readers of a real repo reported (ADR 0124 addendum A-read), on the invented
 * forge-limits service (`fixtures/verify-read/`).
 */
describe("atticus verify: files read with nothing to record, and a read that is complete (A-read)", () => {
  const READ = join(__dirname, "..", "..", "..", "fixtures", "verify-read");
  const limits = (reviewed?: string): string => {
    const root = mkdtempSync(join(tmpdir(), "atticus-verify-read-"));
    cpSync(join(READ, "repo"), root, { recursive: true });
    mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
    mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
    cpSync(
      join(READ, "forge-limits.facts.jsonl"),
      join(root, ".atticus", "facts", "forge-limits.jsonl"),
    );
    if (reviewed !== undefined)
      writeFileSync(join(root, ".atticus", "facts", "forge-limits.reviewed.jsonl"), reviewed);
    return root;
  };
  const reviewedFixture = () => readFileSync(join(READ, "forge-limits.reviewed.jsonl"), "utf8");
  const report = (root: string) =>
    parse(readFileSync(join(root, ".atticus", "facts", "forge-limits.verify.yaml"), "utf8"));

  it("asks for the unknown files, and says where a file read with nothing in it is recorded", async () => {
    const root = limits();
    const o = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(o.out[0]).toMatch(/coverage 67% \(6 read, 3 unknown\)/);
    expect(text).toMatch(/Next: read the 3 unknown files/);
    expect(text).toContain(".atticus/facts/forge-limits.reviewed.jsonl");
    expect(text).not.toMatch(/The read is complete/);
  });

  it("counts reviewed files apart, lists them with why in the report, and says the read is complete", async () => {
    const root = limits(reviewedFixture());
    const o = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(o.out[0]).toMatch(
      /coverage 67% \(6 read, 3 reviewed with nothing to record, 0 unknown\)/,
    );
    expect(text).toMatch(/The read is complete: every source file is read \(6\) or reviewed/);
    expect(text).not.toMatch(/Next: read/);
    const r = report(root);
    expect(r.coverage.reviewed).toBe(3);
    expect(r.coverage.unknown).toEqual([]);
    expect(r.reviewed).toEqual([
      {
        path: "src/main/java/forge/limits/calc/*.java",
        why: "pure arithmetic and a constant table of caps: no route, call, store, field or setting",
        files: [
          "src/main/java/forge/limits/calc/Rounding.java",
          "src/main/java/forge/limits/calc/Tiers.java",
        ],
      },
      {
        path: "src/main/java/forge/limits/InvalidAmount.java",
        why: "an exception type the flow's error path throws; it holds no fact of its own",
        files: ["src/main/java/forge/limits/InvalidAmount.java"],
      },
    ]);
  });

  it("refuses a reviewed line that names no file of the repo, or isn't one, and exits 1", async () => {
    const root = limits(
      reviewedFixture() +
        `${JSON.stringify({ path: "src/main/java/forge/limits/Gone.java", why: "read it" })}\n{not json\n`,
    );
    const o = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, o.io)).toBe(1);
    const rejected = readFileSync(
      join(root, ".atticus", "facts", "forge-limits.rejected.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { code: string; message: string });
    expect(rejected.map((r) => r.code)).toEqual(["bad-reviewed", "bad-reviewed"]);
    expect(rejected[0]!.message).toMatch(/line 3: .*Gone\.java.*not in the repo at this commit/);
    expect(rejected[1]!.message).toMatch(/line 4/);
    expect(o.out.join("\n")).toMatch(/bad-reviewed/);
    // The good lines still count.
    expect(report(root).coverage.reviewed).toBe(3);
  });

  // A-uncited: the claim stays in the reader's own file, and out of the catalog. It used to be
  // stripped from the file here, which erased this very warning on the next run.
  it("keeps an entry's uncited auth in the facts file, says so, and says the same next run", async () => {
    const root = limits(reviewedFixture());
    const facts = join(root, ".atticus", "facts", "forge-limits.jsonl");
    writeFileSync(
      facts,
      readFileSync(facts, "utf8").replace(
        '"handler":"LimitController.tiers"',
        '"handler":"LimitController.tiers","auth":"mtls"',
      ),
    );
    const o = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, o.io)).toBe(0);
    const noted = [
      {
        id: "e-get-tiers",
        auth: "mtls",
        cite: "src/main/java/forge/limits/LimitController.java:24",
      },
    ];
    expect(o.out.join("\n")).toMatch(/1 entry's auth rests on no cited line/);
    expect(o.out.join("\n")).toMatch(/give each entry an authCite/);
    expect(report(root).authUncited).toEqual(noted);
    expect(readFileSync(facts, "utf8")).toContain('"auth":"mtls"');

    const again = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, again.io)).toBe(0);
    expect(again.out.join("\n")).toMatch(/1 entry's auth rests on no cited line/);
    expect(report(root).authUncited).toEqual(noted);
  });

  /**
   * The two rewrites the facts file does get, with the reasons they differ from the auth claim
   * (A-uncited): a secret must not sit on disk, so it goes and stays gone; a quote the cited line
   * can't be checked against is evidence, not a claim, and is counted rather than passed over.
   */
  it("redacts a secret in a quote on disk, and the quote stays redacted on the next run", async () => {
    const root = limits(reviewedFixture());
    const facts = join(root, ".atticus", "facts", "forge-limits.jsonl");
    const secret = "forge-limits-k3y-not-a-real-one";
    mkdirSync(join(root, "src", "main", "resources"), { recursive: true });
    writeFileSync(
      join(root, "src", "main", "resources", "limits.yml"),
      `limits:\n  gate:\n    api-key: ${secret}\n`,
    );
    appendFileSync(
      facts,
      JSON.stringify({
        kind: "config",
        id: "k-gate-key",
        repo: "forge-limits",
        commit: "4d1c0de",
        component: "limits-api",
        settingKind: "config",
        key: "limits.gate.api-key",
        cite: {
          file: "src/main/resources/limits.yml",
          line: 3,
          value: "api-key",
          quote: `    api-key: ${secret}`,
        },
      }) + "\n",
    );
    const o = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, o.io)).toBe(0);
    expect(o.out.join("\n")).toMatch(/1 quotes? had a secret value redacted/);
    const kept = readFileSync(facts, "utf8");
    expect(kept).not.toContain(secret);
    expect(kept).toContain("<redacted>");
    // and again: the secret doesn't come back, and nothing claims a new redaction
    const again = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, again.io)).toBe(0);
    expect(readFileSync(facts, "utf8")).toBe(kept);
    expect(again.out.join("\n")).not.toMatch(/secret value redacted/);
  });

  it("counts a quote left off because the cited line can't be quoted", async () => {
    const root = limits(reviewedFixture());
    const facts = join(root, ".atticus", "facts", "forge-limits.jsonl");
    // A minified bundle: `quoteNotRequired` holds for it, so a quote that doesn't match the line
    // is left off rather than rejecting the fact. That used to be silent.
    mkdirSync(join(root, "src", "main", "resources"), { recursive: true });
    writeFileSync(
      join(root, "src", "main", "resources", "limits.min.js"),
      `var forgeLimits={path:"/limits/caps"};\n`,
    );
    appendFileSync(
      facts,
      JSON.stringify({
        kind: "entry",
        id: "e-get-caps",
        repo: "forge-limits",
        commit: "4d1c0de",
        component: "limits-api",
        entryType: "rest",
        method: "GET",
        path: "/limits/caps",
        cite: {
          file: "src/main/resources/limits.min.js",
          line: 1,
          value: "/limits/caps",
          quote: "a line this bundle does not hold",
        },
      }) + "\n",
    );
    const o = io();
    expect(await verifyCommand(root, "forge-limits", { commit: "4d1c0de" }, o.io)).toBe(0);
    expect(o.out.join("\n")).toMatch(/1 quote was left off .*the claim itself was still checked/);
    expect(report(root).quotesDropped).toBe(1);
    const kept = readFileSync(facts, "utf8");
    expect(kept).toContain('"e-get-caps"');
    expect(kept).not.toContain("a line this bundle does not hold");
  });
});

/**
 * What a repo is built on (ADR 0124 addendum A-framework), on `fixtures/frameworks/`: the report
 * says it, a framework whose patterns the facts show none of is a question in the report and in
 * the words the command prints, and a house framework nothing can read is offered to be learned.
 */
describe("atticus verify <repo>: what the repo is built on", () => {
  const FW = join(__dirname, "..", "..", "..", "fixtures", "frameworks");
  const COMMIT = "4f1d2a9c8b7e6f5a4d3c2b1a0978563412fedcba";
  function repoWithFacts(repo: string): string {
    const root = mkdtempSync(join(tmpdir(), "atticus-verify-fw-"));
    cpSync(join(FW, "repos", repo), root, { recursive: true });
    mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
    mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
    cpSync(join(FW, "facts", `${repo}.jsonl`), join(root, ".atticus", "facts", `${repo}.jsonl`));
    return root;
  }
  const reportOf = (root: string, repo: string) =>
    parse(readFileSync(join(root, ".atticus", "facts", `${repo}.verify.yaml`), "utf8"));

  it("says what it is built on, with the version and where", async () => {
    const root = repoWithFacts("forge-ledger-api");
    const o = io();
    expect(await verifyCommand(root, "forge-ledger-api", { commit: COMMIT }, o.io)).toBe(0);
    expect(o.out.join("\n")).toContain("Built on forge-web-starter 2.8.1, spring-boot 3.3.4");
    expect(reportOf(root, "forge-ledger-api").frameworks).toEqual([
      {
        name: "forge-web-starter",
        version: "2.8.1",
        cite: "web/pom.xml:17",
        component: "ledger-web",
      },
      { name: "spring-boot", version: "3.3.4", cite: "pom.xml:6" },
    ]);
  });

  it("asks a person about a framework whose patterns none of the facts show", async () => {
    const root = repoWithFacts("forge-cards-api");
    const o = io();
    expect(await verifyCommand(root, "forge-cards-api", { commit: COMMIT }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(text).toContain("shows none of its patterns in the facts");
    expect(text).toContain("Were its entry points missed");
    const gaps = reportOf(root, "forge-cards-api").frameworkGaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].framework).toBe("spring-boot");
    expect(gaps[0].expected).toBe("rest");
  });

  it("offers to learn a house framework rather than read it as ordinary code", async () => {
    const root = repoWithFacts("forge-cards-api");
    const o = io();
    expect(await verifyCommand(root, "forge-cards-api", { commit: COMMIT }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(text).toContain("nothing here can read yet");
    expect(text).toContain("atticus frameworks learn forge-card-starter --from forge-cards-api");
  });

  it("says nothing about frameworks for a repo whose facts name none", async () => {
    const root = adoptedRepo(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
    const o = io();
    expect(await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(text).not.toContain("Built on");
    const r = parse(
      readFileSync(join(root, ".atticus", "facts", "forge-ledger.verify.yaml"), "utf8"),
    );
    expect(r.frameworks).toBeUndefined();
    expect(r.frameworkGaps).toBeUndefined();
  });
});
