import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { questionFromDraft, writeQuestion } from "@maycombhq/core";
import { runCritic, type CriticResult } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot, write } from "./helpers.js";

/**
 * A change that rests on a map error says so (ADR 0140, P4): a link the join guessed (inferred,
 * joined by path or by a host's label), a link question still open for a call the change plans,
 * or a repo whose read is stale or incomplete. On the Forge change add-transfer-limit, which
 * changes POST /transfers (if-d99f508a2ac9b6e0, portal-bff to ledger-api) and POST /audit/events
 * (if-5c55930b735276a9, portal-bff to audit-svc) and adds GET /accounts/{id}/limit.
 */

const RULE = "constitution.change-links-known";
const of = (r: CriticResult) => r.findings.filter((f) => f.finding.rule === RULE);
const A = "a".repeat(40);
const B = "b".repeat(40);

/** Mark a catalog Interface as the join made it: inferred, with these flags. */
async function guessed(root: string, id: string, flags: string[]) {
  const p = join(root, "catalog/generated/interface", `${id}.yaml`);
  const r = parse(await readFile(p, "utf8")) as Record<string, unknown>;
  await writeFile(p, stringify({ ...r, confidence: "inferred", flags }));
}

const call = (id: string, file: string, line: number, method: string, path: string) => ({
  kind: "call",
  id,
  repo: "forge-portal-bff",
  commit: A,
  cite: { file, line, value: path },
  verified: "line",
  callType: "rest",
  method,
  path,
});
const AUDIT = call(
  "bff.audit",
  "src/main/java/forge/portal/AuditPublisher.java",
  10,
  "POST",
  "/audit/events",
);
const LIMIT = call(
  "bff.limit",
  "src/main/java/forge/portal/LimitClient.java",
  7,
  "GET",
  "/accounts/{accountId}/limit",
);

/** forge-portal-bff read: its facts, the verifier's report and its checkout at `head`. */
async function read(root: string, o: { head?: string; report?: boolean } = {}) {
  await write(
    root,
    "facts/forge-portal-bff.jsonl",
    [AUDIT, LIMIT].map((f) => JSON.stringify(f)).join("\n") + "\n",
  );
  if (o.report !== false)
    await write(
      root,
      "facts/forge-portal-bff.verify.yaml",
      `accepted: 2\nrejected: 0\ncommit: ${A}\ncoverage: { ratio: 1, read: 2, unknown: [] }\n`,
    );
  await write(root, "workspace/forge-portal-bff/.git/HEAD", `${o.head ?? A}\n`);
}

async function ask(root: string, evidence: string[], question: string) {
  const q = questionFromDraft(
    { question, options: [], evidence, scope: "repo" },
    {
      step: "facts-targets",
      repo: "forge-portal-bff",
      command: "atticus verify forge-portal-bff --write",
      rerun: "atticus verify forge-portal-bff --write",
      at: NOW,
    },
  );
  await writeQuestion(root, q);
  return q;
}

describe("a change that rests on a guessed link says so (ADR 0140)", () => {
  it("says nothing on the Forge change, whose links are read from code", async () => {
    expect(of(await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW }))).toEqual([]);
  });

  it("asks the caller's owner about a call the join found by path", async () => {
    const root = await forgeChangeRoot();
    await guessed(root, "if-d99f508a2ac9b6e0", ["joined-by-path"]);
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f.map((x) => [x.finding.kind, x.finding.lens, x.finding.summary])).toEqual([
      [
        "knowledge-gap",
        "true",
        "The change rests on a guessed link: the map joined portal-bff to ledger-api (POST /transfers) by path, not from code that names ledger-api.",
      ],
    ]);
    expect(f[0]!.finding.question?.text).toBe(
      "Does portal-bff's POST /transfers go to ledger-api? The map joined them by path: nothing in portal-bff's code names ledger-api.",
    );
    expect(f[0]!.finding.question?.owner).toBe("team-portal");
    expect(f[0]!.finding.evidence).toContainEqual({
      source: "catalog",
      record: "if-d99f508a2ac9b6e0",
    });
    expect(f[0]!.finding.evidence[0]).toMatchObject({ source: "artifact", path: "interfaces.md" });
  });

  it("says a join by a host's first label is a guess too", async () => {
    const root = await forgeChangeRoot();
    await guessed(root, "if-5c55930b735276a9", ["joined-by-label"]);
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f).toHaveLength(1);
    expect(f[0]!.finding.summary).toContain("by a host's first label");
  });

  it.each([
    ["joined-by-platform-setting", "by a platform-wide setting nobody set for it"],
    ["joined-by-folder-name", "by the folder name of the setting that gives its host"],
    ["joined-despite-conflict", "by a host or base path an open conflict disputes"],
  ])("says a join flagged %s is a guess too (J0, J1)", async (flag, words) => {
    const root = await forgeChangeRoot();
    await guessed(root, "if-5c55930b735276a9", [flag]);
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f).toHaveLength(1);
    expect(f[0]!.finding.summary).toContain(words);
  });

  it("asks nothing of a join a person, a name, a repo or a host made", async () => {
    const root = await forgeChangeRoot();
    await guessed(root, "if-d99f508a2ac9b6e0", ["joined-by-answer"]);
    await guessed(root, "if-5c55930b735276a9", ["joined-by-host"]);
    expect(of(await runCritic(root, CHANGE, { now: NOW }))).toEqual([]);
  });
});

describe("a change that rests on an open link question says so (ADR 0140)", () => {
  it("names the open question about a call the change changes, citing its file", async () => {
    const root = await forgeChangeRoot();
    await read(root);
    const q = await ask(
      root,
      [`${AUDIT.cite.file}:${AUDIT.cite.line}`],
      "Which repo or system answers POST /audit/events, which forge-portal-bff calls?",
    );
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f.map((x) => x.finding.summary)).toEqual([
      `The call from portal-bff to audit-svc (POST /audit/events) rests on an open question, ${q.id}: which repo or system answers it.`,
    ]);
    expect(f[0]!.finding.kind).toBe("knowledge-gap");
    expect(f[0]!.finding.question?.text).toBe(q.question);
    expect(f[0]!.finding.fix.text).toContain(`atticus questions answer ${q.id}`);
    expect(f[0]!.finding.evidence).toContainEqual({
      source: "manual",
      path: `questions/${q.id}.yaml`,
    });
  });

  it("finds a new call's question by its path, placeholders aside", async () => {
    const root = await forgeChangeRoot();
    await read(root);
    const q = await ask(
      root,
      [`${LIMIT.cite.file}:${LIMIT.cite.line}`],
      "Which repo or system answers GET /accounts/{accountId}/limit, which forge-portal-bff calls?",
    );
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f.map((x) => x.finding.summary)).toEqual([
      `The call from portal-bff to ledger-api (GET /accounts/{id}/limit) rests on an open question, ${q.id}: which repo or system answers it.`,
    ]);
  });

  it("says nothing of a question about another call, or one answered", async () => {
    const root = await forgeChangeRoot();
    await read(root);
    await ask(root, ["src/main/java/forge/portal/Other.java:3"], "Which answers GET /other?");
    expect(of(await runCritic(root, CHANGE, { now: NOW }))).toEqual([]);
  });
});

describe("a change that rests on a stale or incomplete read says so (ADR 0140)", () => {
  it("says once for a repo read at another commit than its checkout, with the command", async () => {
    const root = await forgeChangeRoot();
    await read(root, { head: B });
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f.map((x) => [x.finding.kind, x.finding.severity, x.finding.summary])).toEqual([
      [
        "issue",
        "risk",
        "The change rests on forge-portal-bff, whose read is stale: its facts were read at aaaaaaa and the checkout is at bbbbbbb.",
      ],
    ]);
    expect(f[0]!.finding.fix.text).toContain("atticus map forge-portal-bff");
  });

  it("says a repo nobody verified is incomplete", async () => {
    const root = await forgeChangeRoot();
    await read(root, { report: false });
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(f.map((x) => x.finding.summary)).toEqual([
      "The change rests on forge-portal-bff, whose read is incomplete: nobody has run the verifier on its facts.",
    ]);
    expect(f[0]!.finding.fix.text).toContain("atticus verify forge-portal-bff");
  });
});
