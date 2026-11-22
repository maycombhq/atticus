import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseFacts, type Fact } from "@maycombhq/core";
import {
  claimFindingId,
  conformClaims,
  readClaims,
  type ClaimResult,
  type ClaimsInput,
} from "../src/index.js";

/**
 * ADR 0206: a change states what the code will have (an operation's `sets`, a quick change's
 * "## In the code" rows), and each claim is looked for in the verified facts of the branch's
 * commit, with one of five outcomes cited to a file and line. Golden files written by hand
 * (fixtures/conform-operations, fixtures/conform-quick); no model, no network.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const OPS = join(FIXTURES, "conform-operations");
const QUICK = join(FIXTURES, "conform-quick");

const facts = (dir: string, name: string): Fact[] => {
  const r = parseFacts(readFileSync(join(dir, "facts", name), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const tree = (dir: string, repo: string) =>
  readFileSync(join(dir, "tree", `${repo}.txt`), "utf8")
    .split("\n")
    .filter(Boolean);
const lineAt = (dir: string, repo: string) => (path: string, line: number) => {
  const p = join(dir, "files", repo, ...path.split("/"));
  return existsSync(p) ? readFileSync(p, "utf8").split("\n")[line - 1] : undefined;
};
const golden = (dir: string, name: string) =>
  parse(readFileSync(join(dir, "expected", name), "utf8")) as unknown;

const cite = (c: ClaimResult["at"][number]) =>
  c.source === "artifact" ? `artifact:${c.path}:${c.line}` : `${c.repo}:${c.path}:${c.line}`;
const compact = (r: ClaimResult) => ({
  outcome: r.outcome,
  check: r.check,
  ...(r.from.operation ? { operation: r.from.operation } : {}),
  ...(r.from.task ? { task: r.from.task } : {}),
  line: r.from.line,
  expected: r.expected,
  ...(r.found ? { found: r.found } : {}),
  what: r.what,
  at: r.at.map(cite),
  ...(r.why ? { why: r.why } : {}),
});

async function opsRun(repo: string, basis: ClaimsInput["basis"]) {
  const { claims, problems } = await readClaims(OPS);
  expect(problems).toEqual([]);
  return conformClaims({
    change: "move-orders-to-anvil",
    changesRel: "openspec/changes",
    repo,
    claims,
    before: facts(OPS, `${repo}.before.jsonl`),
    after: facts(OPS, `${repo}.after.jsonl`),
    files: tree(OPS, repo),
    basis,
    lineAt: lineAt(OPS, repo),
  });
}

describe("conformance of operations (ADR 0206 part A)", () => {
  it("forge-orders: present, written on the line or the assistant's reading, and differently", async () => {
    const r = await opsRun("forge-orders", { from: "facts", unread: [] });
    expect(r.claims.map(compact)).toEqual(golden(OPS, "forge-orders.yaml"));
    // Not in the design is for a change whose whole design is its claims: none here.
    expect(r.unexpected).toEqual([]);
  });

  it("forge-ledger: present differently, missing, not checkable; the secret's literal is never said", async () => {
    const r = await opsRun("forge-ledger", { from: "facts", unread: [] });
    expect(r.claims.map(compact)).toEqual(golden(OPS, "forge-ledger.yaml"));
    expect(JSON.stringify(r)).not.toContain("set-in-file");
  });

  it("a file no fact covers makes what facts would say unconfirmed; the commit's tree still says what it has", async () => {
    const r = await opsRun("forge-ledger", { from: "facts", unread: ["deploy/anvil.yaml"] });
    expect(r.claims.map(compact)).toEqual(golden(OPS, "forge-ledger-unread.yaml"));
    const u = r.claims.find((c) => c.outcome === "unconfirmed")!;
    // The branch's facts are kept in the change folder, never in the catalog (ADR 0206, as built).
    expect(u.next).toBe(
      "Have your assistant read deploy/anvil.yaml in forge-ledger's branch into openspec/changes/move-orders-to-anvil/conform/facts/forge-ledger.jsonl (facts at the branch's commit, each citing its file and line), then check again: atticus change conform move-orders-to-anvil. They are verified here and never written to the catalog.",
    );
  });

  it("present comes from facts only: a repo read by the built-in readers alone confirms nothing", async () => {
    const r = await opsRun("forge-orders", { from: "readers" });
    for (const c of r.claims.filter((x) => x.check !== "pipeline" && x.check !== "cut-over"))
      expect(c.outcome, c.what).toBe("unconfirmed");
    expect(r.claims.find((c) => c.check === "pipeline")!.outcome).toBe("present");
  });

  it("each outcome says what the person does next", async () => {
    const r = await opsRun("forge-ledger", { from: "facts", unread: [] });
    const by = (o: string) => r.claims.find((c) => c.outcome === o)!;
    expect(by("present-differently").next).toBe(
      "Make forge-ledger do what deploy-anvil sets on the branch, or change the operation if the design was wrong (atticus change architecture move-orders-to-anvil), then check again: atticus change conform move-orders-to-anvil. If it is right as it is, waive the finding with a reason.",
    );
    expect(by("missing").next).toBe(
      "Build it on the branch in forge-ledger; if it lives in a repo the change doesn't name, add that repo to the operation. Then check again: atticus change conform move-orders-to-anvil.",
    );
    expect(by("not-checkable").next).toBe(
      'Check it by hand, then say how: atticus finding move-orders-to-anvil conform-not-checked-config-notify-forge-ledger waive --reason "<how it was checked>".',
    );
    const orders = await opsRun("forge-orders", { from: "facts", unread: [] });
    expect(orders.claims[0]!.next).toBe("Nothing: the line is cited for the reviewer.");
  });

  it("a claim's finding keeps its id while the file around it changes", async () => {
    const r = await opsRun("forge-ledger", { from: "facts", unread: [] });
    const missing = r.claims.find((c) => c.outcome === "missing")!;
    expect(claimFindingId(missing)).toBe("conform-missing-pipeline-anvil-pipeline-forge-ledger");
    expect(claimFindingId({ ...missing, from: { ...missing.from, line: 99 } })).toBe(
      claimFindingId(missing),
    );
  });
});

describe("conformance of a quick change (ADR 0206 part B)", () => {
  it("each row of design.md's In the code, and what the branch adds that no row names", async () => {
    const { claims, problems } = await readClaims(join(QUICK, "change"));
    expect(problems).toEqual([]);
    const r = conformClaims({
      change: "refund-receipts",
      changesRel: "openspec/changes",
      repo: "forge-refunds",
      claims,
      before: facts(QUICK, "forge-refunds.before.jsonl"),
      after: facts(QUICK, "forge-refunds.after.jsonl"),
      files: tree(QUICK, "forge-refunds"),
      basis: { from: "facts", unread: [] },
      unexpected: true,
    });
    const want = golden(QUICK, "forge-refunds.yaml") as { claims: unknown; unexpected: unknown };
    expect(r.claims.map(compact)).toEqual(want.claims);
    expect(
      r.unexpected.map((i) => ({
        check: i.check,
        what: i.what,
        record: i.record,
        at: i.at.map(cite),
      })),
    ).toEqual(want.unexpected);
    expect(r.claims.find((c) => c.outcome === "missing")!.next).toBe(
      "Build it on the branch in forge-refunds; if it lives in a repo the change doesn't name, add that repo to the row (design.md:17). Then check again: atticus change conform refund-receipts.",
    );
  });
});
