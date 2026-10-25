import {
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
    expect(o.out.join("\n")).toMatch(/1 question raised for a person/);
    // Asked again by the next verify: the same question, the same file.
    const p = io();
    await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, p.io);
    expect(readdirSync(join(root, ".atticus", "questions"))).toHaveLength(1);
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

  it("leaves out an entry's auth that no line is cited for, and says so", async () => {
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
    expect(o.out.join("\n")).toMatch(/1 entry's auth left out .*authCite/);
    expect(report(root).authUncited).toEqual([
      {
        id: "e-get-tiers",
        auth: "mtls",
        cite: "src/main/java/forge/limits/LimitController.java:24",
      },
    ]);
    expect(readFileSync(facts, "utf8")).not.toContain('"auth":"mtls"');
  });
});
