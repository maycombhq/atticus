import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  HandoffRuntime,
  MockModelProvider,
  MockRuntime,
  ModelRuntime,
  type AiRequest,
} from "@maycombhq/ai";
import {
  completeLensRun,
  readRound,
  registerCodeSearch,
  runCritic,
  type CodeSearch,
} from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, readText } from "./helpers.js";

/**
 * W1 (ADR 0115 addendum, the critic looks in the code): a lens that says something doesn't
 * exist must have looked. The lens prompt names the repos' clones and tells it to search them
 * before raising an absence; the lens lists the names it says are missing (`absent`), and
 * Atticus checks each against the catalog and the code. A name found makes the finding a note
 * citing where it was found, never a silent drop. Invented Forge names throughout.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN_REVIEW = join(HERE, "../../../fixtures/stages/pin-note/checklists/pin-review.yaml");
const SERVICE = [
  "package forge.ledger;",
  "",
  "public class TransferLimitGuard {",
  "  boolean overLimit(long cents) { return cents > 0; }",
  "}",
  "",
].join("\n");

async function root(o: { workspace?: boolean } = {}) {
  const r = await forgeChangeRoot();
  await cp(PIN_REVIEW, join(r, "org-pack/checklists/pin-review.yaml"));
  const gates = join(r, "org-pack/gates.yaml");
  await writeFile(
    gates,
    (await readFile(gates, "utf8")).replace(
      /(approvers: \[team-lead\]\r?\n\s+checklists: \[forge-architecture)\]/,
      "$1, pin-review]",
    ),
  );
  if (o.workspace !== false) {
    const f = join(r, "workspace/forge-ledger/src/main/java/forge/ledger/TransferLimitGuard.java");
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, SERVICE);
  }
  const brief = (await readText(join(changeDir(r), "brief.md"))).split("\n");
  const line = brief.findIndex((l) => l.startsWith("In scope: a per-account daily limit")) + 1;
  return { root: r, line, quote: brief[line - 1]!.slice(0, 40) };
}

const lensAnswer = (
  line: number,
  quote: string,
  o: { absent?: string[]; kind?: "issue" | "knowledge-gap"; summary?: string } = {},
) =>
  stringify({
    findings: [
      {
        rule: "brief-scope-delivered",
        ...(o.kind ? { kind: o.kind } : {}),
        artifact: "brief.md",
        locator: { line },
        summary:
          o.summary ??
          "The brief relies on a daily-limit guard in the ledger that the estate doesn't have.",
        why: "Nothing would refuse a transfer over the limit.",
        fix: "Add the guard.",
        evidence: [{ path: "brief.md", line, quote }],
        ...(o.kind === "knowledge-gap"
          ? { question: { text: "Who refuses a transfer over the limit?", owner: "architect" } }
          : {}),
        ...(o.absent ? { absent: o.absent } : {}),
      },
    ],
  });

function lensModel(text: string, prompts: string[] = []) {
  return new MockRuntime((r: AiRequest) => {
    prompts.push(r.pack.prompt);
    return r.agent.id === "complete-critic" ? text : "findings: []\n";
  });
}

/** Stands in for the CLI's search (namesInCode over the clones): the names it was asked, found. */
function search(found: Record<string, string>, asked: string[][] = []): CodeSearch {
  return async (_root, names) => {
    asked.push(names);
    return new Map(names.filter((n) => found[n]).map((n) => [n, found[n]!]));
  };
}

const scoped = async (r: string) =>
  (await readRound(r, CHANGE, "plan", 1)).findings.find(
    (f) => f.finding.rule === "brief-scope-delivered",
  )!.finding;

afterEach(() => registerCodeSearch(undefined));

describe("the lenses look in the code before raising an absence (W1)", () => {
  it("names the repos' clones and says to search them before saying something doesn't exist", async () => {
    const { root: r, line, quote } = await root();
    const prompts: string[] = [];
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(lensAnswer(line, quote), prompts),
    });
    const p = prompts.find((x) => x.includes("complete lens"))!;
    expect(p).toContain("workspace/forge-ledger");
    expect(p).toContain("Before you report that something doesn't exist");
    expect(p).toContain("absent:");
  });

  it("leaves the prompt as it was when no repo is cloned (recorded prompts still replay)", async () => {
    const { root: r, line, quote } = await root({ workspace: false });
    const prompts: string[] = [];
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(lensAnswer(line, quote), prompts),
    });
    const p = prompts.find((x) => x.includes("complete lens"))!;
    expect(p).not.toContain("Before you report that something doesn't exist");
    expect(p).not.toContain("absent:");
  });

  it("offers a lens the same read-only tools the drafter has, in model mode", async () => {
    const { root: r, line, quote } = await root();
    // The Forge complete lens runs where its agent allows: here, on the model runtime too.
    const agentFile = join(r, "org-pack/agents/complete-critic.yaml");
    await writeFile(
      agentFile,
      (await readFile(agentFile, "utf8")).replace(
        "allowedRuntimes: [hand-off, mock, replay]",
        "allowedRuntimes: [hand-off, model, mock, replay]",
      ),
    );
    const asked: string[] = [];
    const provider = new MockModelProvider(
      "mock-model",
      (prompt) => (prompt.includes("complete lens") ? lensAnswer(line, quote) : "findings: []\n"),
      () => ({}),
    );
    const runtime = new ModelRuntime(provider, {
      tools: (req) => {
        asked.push(req.agent.id);
        return {
          definitions: [
            { name: "grep", description: "Search the code.", inputSchema: { type: "object" } },
          ],
          call: async () => "",
        };
      },
    });
    await runCritic(r, CHANGE, { gate: "plan", now: NOW, runtime });
    expect(asked).toContain("complete-critic");
    expect(provider.chats.some((c) => c.tools.some((t) => t.name === "grep"))).toBe(true);
  });

  it("makes a finding a note, citing the code, when a name it says is missing is declared there", async () => {
    const { root: r, line, quote } = await root();
    const asked: string[][] = [];
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(lensAnswer(line, quote, { absent: ["TransferLimitGuard"] })),
      codeSearch: search(
        {
          TransferLimitGuard: "forge-ledger:src/main/java/forge/ledger/TransferLimitGuard.java:3",
        },
        asked,
      ),
    });
    expect(asked.flat()).toContain("TransferLimitGuard");
    const f = await scoped(r);
    expect(f.severity).toBe("idea");
    expect(f.kind).toBe("issue");
    expect(f.evidence).toContainEqual({
      source: "code",
      repo: "forge-ledger",
      path: "src/main/java/forge/ledger/TransferLimitGuard.java",
      line: 3,
      quote: "TransferLimitGuard",
    });
    expect(f.why).toMatch(
      /Atticus found TransferLimitGuard in the code \(forge-ledger:src\/main\/java\/forge\/ledger\/TransferLimitGuard\.java:3\)/,
    );
  });

  it("makes a knowledge gap a note too, never dropping it, and cites a catalog record it names", async () => {
    const { root: r, line, quote } = await root();
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(
        lensAnswer(line, quote, { kind: "knowledge-gap", absent: ["post /transfers/"] }),
      ),
      codeSearch: search({}),
    });
    const f = await scoped(r);
    expect(f.kind).toBe("issue");
    expect(f.severity).toBe("idea");
    expect(f.question).toBeUndefined();
    expect(f.evidence).toContainEqual({ source: "catalog", record: "ledger-api.post-transfer" });
    expect(f.why).toMatch(/the catalog's Endpoint ledger-api\.post-transfer/);
  });

  it("keeps the finding as the rule says when nothing it names is found", async () => {
    const { root: r, line, quote } = await root();
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(lensAnswer(line, quote, { absent: ["DailyLimitLedger"] })),
      codeSearch: search({}),
    });
    const f = await scoped(r);
    expect(f.severity).toBe("blocking");
    expect(f.evidence.every((e) => e.source === "artifact")).toBe(true);
  });

  it("checks a hand-off lens's answer the same way, with the search the command line registers", async () => {
    const { root: r, line, quote } = await root();
    registerCodeSearch(
      search({
        TransferLimitGuard: "forge-ledger:src/main/java/forge/ledger/TransferLimitGuard.java:3",
      }),
    );
    const rt = new HandoffRuntime({ root: r, validate: async () => [], now: () => new Date(NOW) });
    const res = await runCritic(r, CHANGE, { gate: "plan", now: NOW, runtime: rt });
    const lens = res.lenses.find((l) => l.lens === "complete" && l.state === "waiting")!;
    const prompt = await readFile(join(r, ".runs", CHANGE, lens.runId!, "prompt.md"), "utf8");
    expect(prompt).toContain("workspace/forge-ledger");
    await writeFile(
      join(r, ".runs", CHANGE, lens.runId!, "findings-complete.yaml"),
      lensAnswer(line, quote, { absent: ["TransferLimitGuard"] }),
    );
    await completeLensRun(r, await rt.done(lens.runId!), { now: NOW });
    expect((await scoped(r)).severity).toBe("idea");
  });
});
