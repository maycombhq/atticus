import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { answerQuestion, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { act, checkRoundDue, gateStatus, runCritic } from "../src/index.js";
import { CHANGE, FORGE_CHANGE, NOW, changeDir, forgeChangeRoot } from "./helpers.js";

/**
 * A checking round that found nothing blocking (ADR 0115 addendum, 2026-10-24), from a live
 * run: at a gate with a limit of two rounds, round 3 was the checking round, with no blocking
 * finding and one gap. A person then answered the draft's question and wrote the gap's fact in
 * by hand; the stage drafted again and stopped, telling them to act on round 3's blocking
 * findings, which it has none of. A checking round is due once nothing blocking from the newest
 * counted round is open and a person acted since it ran: on any of its findings, a gap included,
 * or by answering a question raised for the change.
 */

const replay = () =>
  ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), { now: () => new Date(NOW) });
const LATER = "2026-10-21T10:00:00Z";
const ROUND3 = "2026-10-22T10:00:00Z";
const AFTER = "2026-10-22T11:00:00Z";

/** Rounds 1 and 2 by the critic, then a checking round 3 with one gap and nothing blocking. */
async function afterCleanCheckRound() {
  const root = await forgeChangeRoot();
  await runCritic(root, CHANGE, { now: NOW, runtime: await replay() });
  const r2 = await runCritic(root, CHANGE, { now: LATER, runtime: await replay() });
  const blocking = r2.findings.filter((f) => f.finding.severity === "blocking");
  for (const f of blocking)
    await act(root, CHANGE, f.finding.id, "apply", { by: "ari", now: LATER });
  const gap = r2.findings.find((f) => f.finding.kind === "knowledge-gap")!;
  // Round 3: what the checking round found, written as the critic writes a round.
  const dir2 = join(changeDir(root), "review/plan/2");
  const dir3 = join(changeDir(root), "review/plan/3");
  await cp(dir2, dir3, { recursive: true });
  for (const n of await readdir(dir3))
    if (n.endsWith(".yaml") && n !== `${gap.finding.id}.yaml`) await rm(join(dir3, n));
  const g = parse(await readFile(join(dir3, `${gap.finding.id}.yaml`), "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    join(dir3, `${gap.finding.id}.yaml`),
    stringify({ ...g, round: 3, state: "open", createdAt: ROUND3, resolution: undefined }),
  );
  const meta = parse(await readFile(join(dir3, "meta/round.yaml"), "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    join(dir3, "meta/round.yaml"),
    stringify({
      ...meta,
      round: 3,
      createdAt: ROUND3,
      findings: [
        { id: gap.finding.id, layer: "deterministic", rule: gap.finding.rule, severity: "gap" },
      ],
      checkRound: { after: 2, actedOn: blocking.map((f) => f.finding.id) },
    }),
  );
  return { root, gap: gap.finding.id };
}

describe("a checking round that found nothing blocking (ADR 0115 addendum)", () => {
  it("never asks a person to act on blocking findings there aren't, and says what makes a round due", async () => {
    const { root } = await afterCleanCheckRound();
    expect(await checkRoundDue(root, CHANGE, "plan")).toEqual([]);
    const e = await runCritic(root, CHANGE, { now: AFTER }).then(
      () => undefined,
      (x: Error) => x,
    );
    expect(e?.message).toContain(
      "Nothing blocking is open in round 3, but nobody has acted since it ran",
    );
    expect(e?.message).toContain("answer the change's open questions");
    expect(e?.message).not.toContain("act on each blocking finding");
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.checkRoundsRun).toBe(1);
    expect(s.checkRound).toBe(false);
  });

  it("allows a checking round once a person writes a gap's fact in by hand", async () => {
    const { root, gap } = await afterCleanCheckRound();
    await act(root, CHANGE, gap, "edit-and-apply", {
      by: "ari",
      reason: "Wrote the owner into data.md by hand.",
      now: AFTER,
    });
    expect(await checkRoundDue(root, CHANGE, "plan")).toEqual([gap]);
    expect((await gateStatus(root, CHANGE, "plan")).checkRound).toBe(true);
    const r4 = await runCritic(root, CHANGE, { now: AFTER, runtime: await replay() });
    expect(r4.round).toBe(4);
    expect(r4.checkRound).toBe(true);
    const meta = parse(
      await readFile(join(changeDir(root), "review/plan/4/meta/round.yaml"), "utf8"),
    ) as { checkRound?: { after: number; actedOn: string[] } };
    expect(meta.checkRound).toEqual({ after: 3, actedOn: [gap] });
  });

  it("allows a checking round once a person answers a question raised for the change", async () => {
    const { root } = await afterCleanCheckRound();
    const asked = await raiseQuestions(
      root,
      [
        QuestionDraft.parse({
          question: "Is the limit per account or per customer?",
          evidence: [`openspec/changes/${CHANGE}/brief.md:10`],
          options: [],
          scope: "repo",
        }),
      ],
      {
        step: "change-feature",
        repo: CHANGE,
        command: `atticus change feature ${CHANGE}`,
        rerun: `atticus change feature ${CHANGE}`,
        at: ROUND3,
      },
    );
    const q = asked.raised[0]!;
    expect(await checkRoundDue(root, CHANGE, "plan")).toEqual([]);
    await answerQuestion(root, q.id, { text: "Per account.", by: "priya.nair", at: AFTER });
    expect(await checkRoundDue(root, CHANGE, "plan")).toEqual([q.id]);
  });

  it("still needs a person's decision for each further round", async () => {
    const { root, gap } = await afterCleanCheckRound();
    await act(root, CHANGE, gap, "edit-and-apply", {
      by: "ari",
      reason: "Wrote it in.",
      now: AFTER,
    });
    await runCritic(root, CHANGE, { now: AFTER, runtime: await replay() });
    // Round 4 is the newest counted round now: nothing anyone did since it ran.
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.checkRoundsRun).toBe(2);
    expect(s.checkRound).toBe(false);
  });
});
