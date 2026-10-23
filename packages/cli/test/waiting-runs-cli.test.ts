import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runShowCli, runsCli } from "../src/runs-commands.js";
import { readWaiting, waitingCli, type WaitingRun } from "../src/waiting-commands.js";

/**
 * ADR 0105 and 0106 in every surface: `atticus waiting` (what waits on a person, by change or by
 * kind, with a filter) and `atticus runs` (what Atticus asked a model and what came back), for
 * the IntelliJ plugin's Run a Command and the Claude Code plugin's MCP tools.
 */

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** What each read command prints, as the command line would. */
const CANNED: Record<string, unknown> = {
  "questions list --state open --json": {
    questions: [
      { id: "q-ledger-1", repo: "forge-ledger", question: "Which table holds the daily total?" },
    ],
    problems: [],
  },
  "needs --all --json": [
    {
      item: "firewall-rule-request",
      kind: "request",
      title: "Request a firewall rule to Northwind Pay",
      for: "change",
      status: "open",
      change: "add-transfer-limit",
      handledBy: "network team",
    },
    {
      item: "kafka-topic-request",
      kind: "request",
      title: "Kafka topic",
      for: "story:s1",
      status: "done",
      change: "add-transfer-limit",
    },
    {
      item: "card-processor-onboarding",
      kind: "process",
      title: "Onboard the refund flow with Northwind Pay",
      for: "change",
      status: "open",
      change: "refunds-through-northwind-pay",
    },
  ],
  "todo --json": [
    {
      id: "sd-limit-flag",
      change: "add-transfer-limit",
      title: "Turn on the limit flag in the service desk",
      state: "open",
      where: "Service desk",
    },
    {
      id: "rotate-keys",
      title: "Rotate the gateway keys",
      state: "open",
      where: "Gateway console",
    },
  ],
  "change list --json": [
    { id: "add-transfer-limit", title: "Add a daily transfer limit", state: "plan" },
    {
      id: "refunds-through-northwind-pay",
      title: "Refunds through Northwind Pay",
      state: "define",
    },
    { id: "old-statement-export", title: "Old statement export", state: "released" },
  ],
  "findings refunds-through-northwind-pay --json": [
    {
      id: "f-1",
      summary: "No timeout on the Northwind Pay refund call",
      severity: "blocking",
      state: "open",
    },
  ],
  "findings add-transfer-limit --json": [
    { id: "f-2", summary: "Name the limit's currency", severity: "minor", state: "closed" },
  ],
  "knowledge list --unverified --json": [{ id: "ledger-team" }, { id: "s-gw-vnd" }],
};
const fakeRun: WaitingRun = async (argv) => {
  const key = argv.join(" ");
  if (!(key in CANNED)) return { code: 2, out: "", err: `not canned: ${key}` };
  return { code: 0, out: JSON.stringify(CANNED[key]), err: "" };
};

describe("atticus waiting", () => {
  it("groups what waits by change, blocking first, then what belongs to no change", async () => {
    const w = await readWaiting(fakeRun, {});
    expect(w.changes.map((c) => c.change)).toEqual([
      "refunds-through-northwind-pay",
      "add-transfer-limit",
    ]);
    expect(w.changes[0]).toMatchObject({
      title: "Refunds through Northwind Pay",
      needs: [{ item: "card-processor-onboarding" }],
      findings: [{ id: "f-1", severity: "blocking" }],
      manualSteps: [],
    });
    // A need done, and a closed finding, don't wait on anyone.
    expect(w.changes[1]).toMatchObject({
      needs: [{ item: "firewall-rule-request" }],
      findings: [],
      manualSteps: [{ id: "sd-limit-flag" }],
    });
    expect(w.other).toEqual({
      questions: [
        { id: "q-ledger-1", repo: "forge-ledger", question: "Which table holds the daily total?" },
      ],
      manualSteps: [expect.objectContaining({ id: "rotate-keys" })],
      knowledgeToVerify: 2,
    });
    expect(w.counts).toEqual({
      questions: 1,
      needs: 2,
      manualSteps: 2,
      findings: 1,
      knowledgeToVerify: 2,
    });
  });

  it("filters by words in a title, id, change or repo, case-insensitively", async () => {
    const w = await readWaiting(fakeRun, { filter: "NORTHWIND" });
    expect(w.changes.map((c) => c.change)).toEqual([
      "refunds-through-northwind-pay",
      "add-transfer-limit",
    ]);
    expect(w.changes[1]!.manualSteps).toEqual([]);
    expect(w.other.questions).toEqual([]);
    const ledger = await readWaiting(fakeRun, { filter: "forge-ledger" });
    expect(ledger.changes).toEqual([]);
    expect(ledger.other.questions).toHaveLength(1);
  });

  it("prints it by change or by kind, and as JSON", async () => {
    const c = capture();
    expect(await waitingCli({ by: "change" }, c.io, fakeRun)).toBe(0);
    expect(c.out).toEqual([
      "Refunds through Northwind Pay (refunds-through-northwind-pay): 1 need, 1 finding",
      "  need     card-processor-onboarding: Onboard the refund flow with Northwind Pay",
      "  finding  f-1 (blocking): No timeout on the Northwind Pay refund call",
      "Add a daily transfer limit (add-transfer-limit): 1 need, 1 manual step",
      "  need     firewall-rule-request: Request a firewall rule to Northwind Pay",
      "  step     add-transfer-limit/sd-limit-flag: Turn on the limit flag in the service desk",
      "Not tied to a change:",
      "  question q-ledger-1 (forge-ledger): Which table holds the daily total?",
      "  step     rotate-keys: Rotate the gateway keys",
      "  2 knowledge items no one has verified: atticus knowledge list --unverified",
    ]);
    const k = capture();
    await waitingCli({ by: "kind" }, k.io, fakeRun);
    expect(k.out[0]).toBe("Questions (1)");
    expect(k.out).toContain("Needs (2)");
    const j = capture();
    await waitingCli({ by: "change", json: true }, j.io, fakeRun);
    expect(JSON.parse(j.out.join("\n"))).toMatchObject({ by: "change", counts: { needs: 2 } });
    const none = capture();
    await waitingCli({ filter: "nothing like this" }, none.io, fakeRun);
    expect(none.out).toEqual(['Nothing waits on you that matches "nothing like this".']);
  });
});

describe("atticus runs", () => {
  async function metarepo() {
    const root = join(await mkdtemp(join(tmpdir(), "atticus-runs-cli-")), "meta");
    await mkdir(join(root, "org-pack"), { recursive: true });
    const dir = join(root, ".runs", "knowledge-scan", "run-20261023034002-0001");
    await mkdir(dir, { recursive: true });
    const prompt = `# Task\n\n<atticus-data id="9" kind="document" origin="checks on attempt 1">\nThe answer above failed these checks.\n- team ledger-team: quote: the quote is not on the page, word for word\n</atticus-data>\n`;
    await writeFile(
      join(dir, "run.json"),
      JSON.stringify({
        runId: "run-20261023034002-0001",
        request: {
          change: "knowledge-scan",
          agent: { id: "knowledge-reader" },
          pack: {
            prompt,
            manifest: {
              totalTokens: 902,
              sources: [{ origin: "checks on attempt 1", sha256: "0" }],
            },
          },
          outputPath: "knowledge-items.yaml",
          outputIn: "run",
        },
        runtime: "hand-off",
        state: "validated",
        attempt: 1,
        startedAt: "2026-10-23T03:40:02Z",
        finishedAt: "2026-10-23T03:40:09Z",
        errors: [],
      }),
    );
    await writeFile(join(dir, "prompt.md"), prompt);
    await writeFile(join(dir, "knowledge-items.yaml"), "items: []\n");
    return root;
  }

  it("lists the runs, and shows one with what it was asked, answered and handed back", async () => {
    const root = await metarepo();
    const l = capture();
    expect(await runsCli(root, {}, l.io)).toBe(0);
    expect(l.out).toEqual([
      "run-20261023034002-0001  knowledge-scan  knowledge-reader  round 2  validated  answered  1 problem handed back  2026-10-23 03:40",
    ]);
    const s = capture();
    expect(await runShowCli(root, "run-20261023034002-0001", {}, s.io)).toBe(0);
    expect(s.out).toEqual([
      "run-20261023034002-0001: knowledge-scan, knowledge-reader, round 2, validated (hand-off)",
      "Prompt: .runs/knowledge-scan/run-20261023034002-0001/prompt.md (902 tokens)",
      "Handed back after round 1:",
      "  - team ledger-team: quote: the quote is not on the page, word for word",
      "Answer:",
      "  items: []",
      "Rounds of this step: run-20261023034002-0001 (round 2, validated)",
    ]);
    const missing = capture();
    expect(await runShowCli(root, "run-1-0001", {}, missing.io)).toBe(2);
    expect(missing.err[0]).toBe("There is no run run-1-0001. atticus runs lists them.");
    const empty = capture();
    expect(await runsCli(root, { change: "nothing" }, empty.io)).toBe(0);
    expect(empty.out).toEqual(["No model runs for nothing yet."]);
  });
});
