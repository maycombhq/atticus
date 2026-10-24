import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { answerQuestion, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import {
  act,
  changeAnswers,
  completeLensRun,
  gateStatus,
  readRound,
  roundsUsed,
  runCritic,
} from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, readText } from "./helpers.js";

/**
 * The answers people gave for a change, read by the critic's lenses as part of the brief (ADR
 * 0115 addendum, 2026-10-24): a lens is told a scope a person set by answering isn't a finding,
 * and one that still reports it says which answer it is about. That link is checked as facts
 * (the id is an answer it was given, the quote is the answer's words); a linked finding of a
 * waivable rule is kept as a risk, not a block. The same in model and hand-off modes, and in the
 * critic run on its own (`atticus critic`), outside any stage.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN_REVIEW = join(HERE, "../../../fixtures/stages/pin-note/checklists/pin-review.yaml");
const LATER = "2026-10-21T10:00:00Z";
const ANSWER = "Portal transfers only — not standing orders or Ledger's own reversals.";
const SUMMARY =
  "The draft narrows the brief's limit on POST /transfers to portal transfers only, so standing orders aren't limited.";

async function root(o: { waivable?: boolean } = {}) {
  const r = await forgeChangeRoot();
  await cp(PIN_REVIEW, join(r, "org-pack/checklists/pin-review.yaml"));
  // The plan gate runs it beside the Forge checklist.
  const gates = join(r, "org-pack/gates.yaml");
  await writeFile(
    gates,
    (await readFile(gates, "utf8")).replace(
      /(approvers: \[team-lead\]\r?\n\s+checklists: \[forge-architecture)\]/,
      "$1, pin-review]",
    ),
  );
  if (o.waivable === false) {
    const p = join(r, "org-pack/checklists/pin-review.yaml");
    await writeFile(p, (await readFile(p, "utf8")).replace("waivable: true", "waivable: false"));
  }
  const brief = (await readText(join(changeDir(r), "brief.md"))).split("\n");
  const line = brief.findIndex((l) => l.startsWith("In scope: a per-account daily limit")) + 1;
  const asked = await raiseQuestions(
    r,
    [
      QuestionDraft.parse({
        question: "Which transfers does the daily limit cover?",
        evidence: [`openspec/changes/${CHANGE}/brief.md:${line}`],
        options: [],
        scope: "repo",
      }),
    ],
    {
      step: "change-feature",
      repo: CHANGE,
      command: `atticus change feature ${CHANGE}`,
      rerun: `atticus change feature ${CHANGE}`,
      at: NOW,
    },
  );
  const q = asked.raised[0]!;
  await answerQuestion(r, q.id, { text: ANSWER, by: "priya.nair", at: NOW });
  return { root: r, id: q.id, line, briefLine: brief[line - 1]! };
}

const finding = (line: number, quote: string, link?: { id: string; quote: string }) =>
  stringify({
    findings: [
      {
        rule: "brief-scope-delivered",
        artifact: "brief.md",
        locator: { line },
        summary: SUMMARY,
        why: "The brief asks for a limit on every transfer.",
        fix: "Limit every transfer.",
        evidence: [{ path: "brief.md", line, quote }],
        ...(link ? { answered: link } : {}),
      },
    ],
  });

/** A model that reports the narrowing from the business lens only, and nothing elsewhere. */
function lensModel(text: string, prompts: string[] = []) {
  return new MockRuntime((r: AiRequest) => {
    prompts.push(r.pack.prompt);
    return r.agent.id === "business-critic" ? text : "findings: []\n";
  });
}

const narrowing = async (root: string) =>
  (await readRound(root, CHANGE, "plan", 1)).findings.find(
    (f) => f.finding.rule === "brief-scope-delivered",
  )!.finding;

describe("the critic reads the answers people gave for the change (ADR 0115 addendum)", () => {
  it("lists the change's answered questions, with their answers", async () => {
    const { root: r, id } = await root();
    expect(await changeAnswers(r, CHANGE)).toEqual([
      {
        id,
        question: "Which transfers does the daily limit cover?",
        answer: ANSWER,
        by: "priya.nair",
        at: NOW,
      },
    ]);
  });

  it("gives every lens the answers as data, says a person's scope isn't a finding, and keeps a linked finding as a risk (model, atticus critic)", async () => {
    const { root: r, id, line, briefLine } = await root();
    const prompts: string[] = [];
    const res = await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(
        finding(line, briefLine.slice(0, 40), { id, quote: "Portal transfers only" }),
        prompts,
      ),
    });
    const business = prompts.find((p) => p.includes("business lens"))!;
    expect(business).toContain("answers-on-file");
    expect(business).toContain(ANSWER);
    expect(business).toContain(
      "A scope, a limit or a choice a person set by answering is not a finding",
    );
    const f = await narrowing(r);
    expect(f.severity).toBe("risk");
    expect(f.answered).toEqual({ question: id, quote: "Portal transfers only" });
    expect(
      res.status.findings.some((x) => x.finding.id === f.id && x.finding.severity === "blocking"),
    ).toBe(false);
  });

  it("keeps a finding blocking when its link doesn't check out: an answer it wasn't given, or words not in the answer", async () => {
    const { root: r, id, line, briefLine } = await root();
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(
        finding(line, briefLine.slice(0, 40), { id, quote: "every kind of transfer" }),
      ),
    });
    const f = await narrowing(r);
    expect(f.severity).toBe("blocking");
    expect(f.answered).toBeUndefined();
  });

  it("never lets an answer set aside a rule that can't be waived", async () => {
    const { root: r, id, line, briefLine } = await root({ waivable: false });
    await runCritic(r, CHANGE, {
      gate: "plan",
      now: NOW,
      runtime: lensModel(
        finding(line, briefLine.slice(0, 40), { id, quote: "Portal transfers only" }),
      ),
    });
    const f = await narrowing(r);
    expect(f.severity).toBe("blocking");
    expect(f.answered).toEqual({ question: id, quote: "Portal transfers only" });
  });

  it("reads the link in when a hand-off lens's answer comes back (hand-off)", async () => {
    const { root: r, id, line, briefLine } = await root();
    const rt = new HandoffRuntime({ root: r, validate: async () => [], now: () => new Date(NOW) });
    const res = await runCritic(r, CHANGE, { gate: "plan", now: NOW, runtime: rt });
    const lens = res.lenses.find((l) => l.lens === "business" && l.state === "waiting")!;
    const prompt = await readFile(join(r, ".runs", CHANGE, lens.runId!, "prompt.md"), "utf8");
    expect(prompt).toContain(ANSWER);
    await writeFile(
      join(r, ".runs", CHANGE, lens.runId!, "findings-business.yaml"),
      finding(line, briefLine.slice(0, 40), { id, quote: "Portal transfers only" }),
    );
    await completeLensRun(r, await rt.done(lens.runId!), { now: NOW });
    const f = await narrowing(r);
    expect(f.severity).toBe("risk");
    expect(f.answered?.question).toBe(id);
  });
});

describe("a knowledge gap a person already wrote in by hand", () => {
  it("says, when apply is refused, that edit-and-apply with no patch records it", async () => {
    const { root: r } = await root();
    const res = await runCritic(r, CHANGE, { gate: "plan", now: NOW });
    const gap = res.findings.find((f) => f.finding.kind === "knowledge-gap")!;
    const e = await act(r, CHANGE, gap.finding.id, "apply", { by: "ari", now: LATER }).then(
      () => undefined,
      (x: Error) => x,
    );
    expect(e?.message).toContain(
      `If you already wrote it into ${gap.finding.artifact} by hand, record that with: atticus finding ${CHANGE} ${gap.finding.id} edit-and-apply --reason "<what you wrote>" (no patch needed).`,
    );
    const done = await act(r, CHANGE, gap.finding.id, "edit-and-apply", {
      by: "ari",
      reason: "Wrote the owner into data.md by hand.",
      now: LATER,
    });
    expect(done.finding.state).toBe("applied");
  });
});

describe("the used rounds in words (ADR 0115 addendum)", () => {
  it("names the checking round once one has run", () => {
    expect(roundsUsed({ maxRounds: 2, checkRoundsRun: 0 })).toBe("its 2 critic rounds are used");
    expect(roundsUsed({ maxRounds: 2, checkRoundsRun: 1 })).toBe(
      "its 2 critic rounds and the checking round are used",
    );
    expect(roundsUsed({ maxRounds: 2, checkRoundsRun: 2 })).toBe(
      "its 2 critic rounds and 2 checking rounds are used",
    );
  });

  it("counts the checking rounds on file in the gate's status", async () => {
    const { root: r } = await root();
    const s = await gateStatus(r, CHANGE, "plan");
    expect(s.checkRoundsRun).toBe(0);
  });
});
