import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { gateStatus, personaLenses, readRound, roundsOf, runCritic } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * ADR 0203 C: a persona's naysayer as a lens of the critic. One naysayer of the Forge org pack
 * whose frontmatter says `gates: [plan]` runs at the plan gate after the four questions, through
 * the same code; its finding is a risk with lens persona and its name, and never holds the gate.
 * With no `gates` it never runs. A mock model; no network.
 */

const NAYSAYER = "ledger-architect-naysayer";
const naysayer = (gates?: string) => `---
name: ${NAYSAYER}
description: Asks what the "Ledger architect" section got wrong or left out.
role: architect
owns: Ledger architect
${gates ? `gates: ${gates}\n` : ""}---

You are the ledger architect's naysayer. Ask who else reads the account's daily limit, and what
happens to a transfer that is refused half way through the velocity check.
`;

/** The design's line a persona's finding quotes. */
const QUOTED = "ledger-api sums today's outgoing entries for the account inside the transfer";

async function root(gates?: string) {
  const r = await forgeChangeRoot();
  await writeFile(join(r, "org-pack/agents", `${NAYSAYER}.md`), naysayer(gates));
  return r;
}

/** Every lens finds nothing but the naysayer, which asks one question with its quote. */
function model(asked: string[]) {
  return new MockRuntime(
    (req: AiRequest) => {
      asked.push(req.agent.id);
      if (req.agent.id !== NAYSAYER) return "findings: []\n";
      return [
        "findings:",
        `  - rule: persona.${NAYSAYER}`,
        "    kind: issue",
        "    artifact: design.md",
        "    locator: { line: 5 }",
        "    summary: Nothing says who else reads the daily limit.",
        "    why: Another reader would see a limit the transfer already passed.",
        "    fix: Name every reader of account.daily_limit.",
        "    evidence:",
        `      - { path: design.md, line: 5, quote: "${QUOTED}" }`,
        "",
      ].join("\n");
    },
    { now: () => new Date(NOW) },
  );
}

describe("a persona's naysayer with gates runs as a lens", () => {
  it("runs at its gate after the four questions; its finding is a risk with lens persona and its name", async () => {
    const r = await root("[plan]");
    const design = await readFile(join(r, "openspec/changes", CHANGE, "design.md"), "utf8");
    expect(design.split("\n")[4]).toContain(QUOTED);
    const asked: string[] = [];
    const out = await runCritic(r, CHANGE, { now: NOW, runtime: model(asked), gate: "plan" });
    // After the four questions, once.
    expect(asked.at(-1)).toBe(NAYSAYER);
    expect(asked.filter((a) => a === NAYSAYER)).toHaveLength(1);
    const lens = out.lenses.find((l) => l.agent === NAYSAYER)!;
    expect(lens).toMatchObject({ state: "ran", persona: NAYSAYER, rules: [`persona.${NAYSAYER}`] });
    const round = (await roundsOf(r, CHANGE, "plan")).at(-1)!;
    const found = (await readRound(r, CHANGE, "plan", round)).findings
      .map((s) => s.finding)
      .filter((f) => f.rule === `persona.${NAYSAYER}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      lens: "persona",
      persona: NAYSAYER,
      severity: "risk",
      layer: "org",
      waivable: false,
      summary: "Nothing says who else reads the daily limit.",
    });
    // The round records the lens by the persona's name.
    const meta = await readFile(
      join(r, "openspec/changes", CHANGE, "review/plan", String(round), "meta/round.yaml"),
      "utf8",
    );
    expect(meta).toContain(`lens: ${NAYSAYER}`);
    // A risk never holds the gate: what blocks is the other rules' findings, and only those.
    const all = (await readRound(r, CHANGE, "plan", round)).findings.map((s) => s.finding);
    const s = await gateStatus(r, CHANGE, "plan");
    expect(s.open.blocking).toBe(
      all.filter((f) => f.severity === "blocking" && f.lens !== "persona").length,
    );
  });

  it("with no gates it never runs, and a gate gates.yaml lacks is said in the round's notes", async () => {
    const quiet: string[] = [];
    await runCritic(await root(), CHANGE, { now: NOW, runtime: model(quiet), gate: "plan" });
    expect(quiet).not.toContain(NAYSAYER);

    const elsewhere: string[] = [];
    const r = await root("[plan, nowhere]");
    const out = await runCritic(r, CHANGE, {
      now: NOW,
      runtime: model(elsewhere),
      gate: "design",
    });
    expect(elsewhere).not.toContain(NAYSAYER);
    expect(out.problems).toContain(
      `${NAYSAYER} gives gate nowhere, which gates.yaml doesn't have, so it never runs there.`,
    );
  });

  it("reads only the org pack's own naysayers, never another team's imported agents", async () => {
    const r = await root("[plan]");
    const all = await personaLenses(r, 1000);
    expect(all.map((p) => [p.name, p.gates, p.owns])).toEqual([
      [NAYSAYER, ["plan"], "Ledger architect"],
    ]);
    expect(all[0]!.rule).toMatchObject({
      id: `persona.${NAYSAYER}`,
      severity: "risk",
      layer: "org",
      persona: NAYSAYER,
    });
    expect(all[0]!.agent.id).toBe(NAYSAYER);
  });
});
