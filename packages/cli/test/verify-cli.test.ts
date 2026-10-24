import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(o.err[0]).toMatch(/Run \/atticus map/);
    writeFileSync(join(root, ".atticus", "facts", "bad.jsonl"), "{not json}\n");
    const p = io();
    expect(await verifyCommand(root, "bad", {}, p.io)).toBe(2);
    expect(p.err.join("\n")).toMatch(/line 1/);
  });
});
