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
