import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { act, recordedFacts, runCritic } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * W2 (ADR 0115 addendum, facts a person recorded): what a person wrote in at one gate (an
 * edit-and-apply reason, a waiver's reason, a dismissal's reason) goes to every later gate's
 * lenses as data, with who and when, and the lens is told not to raise it again unless it cites
 * new evidence against it. Invented Forge names.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN_REVIEW = join(HERE, "../../../fixtures/stages/pin-note/checklists/pin-review.yaml");
const LATER = "2026-10-21T10:00:00Z";
const GAP = "gap-slo-known-ledger";
const ISSUE = "data-retention-stated-data-l8";
const FACT = "The ledger's SLO is 99.9% monthly; wrote it into design.md.";

async function root() {
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
  return r;
}

describe("facts a person recorded reach the later gates' lenses (W2)", () => {
  it("lists each decision with a reason, with who, when, the gate and the finding, once, by time then finding", async () => {
    const r = await root();
    await runCritic(r, CHANGE, { now: NOW, gate: "design" });
    await act(r, CHANGE, GAP, "edit-and-apply", { by: "ari", reason: FACT, now: NOW });
    await act(r, CHANGE, ISSUE, "not-relevant", {
      by: "tia",
      reason: "Retention is the platform default.",
      now: NOW,
    });
    // A later round carries the dismissal; it is still one fact.
    await runCritic(r, CHANGE, { now: LATER, gate: "design" });
    const facts = await recordedFacts(r, CHANGE);
    expect(facts.map((f) => [f.gate, f.finding, f.action, f.by, f.reason])).toEqual([
      ["design", ISSUE, "not-relevant", "tia", "Retention is the platform default."],
      ["design", GAP, "edit-and-apply", "ari", FACT],
    ]);
  });

  it("gives the later gate's lens the facts as data, and the rule that they aren't raised again", async () => {
    const r = await root();
    await runCritic(r, CHANGE, { now: NOW, gate: "design" });
    await act(r, CHANGE, GAP, "edit-and-apply", { by: "ari", reason: FACT, now: NOW });
    const prompts: string[] = [];
    await runCritic(r, CHANGE, {
      now: LATER,
      gate: "plan",
      runtime: new MockRuntime((q: AiRequest) => {
        prompts.push(q.pack.prompt);
        return "findings: []\n";
      }),
    });
    const p = prompts.find((x) => x.includes("business lens"))!;
    expect(p).toContain("recorded-by-people");
    expect(p).toContain(FACT);
    expect(p).toContain("ari");
    expect(p).toContain("2026-10-20");
    expect(p).toContain("A fact a person recorded is not raised again");
  });

  it("adds nothing to the prompt when no person recorded anything", async () => {
    const r = await root();
    const prompts: string[] = [];
    await runCritic(r, CHANGE, {
      now: NOW,
      gate: "plan",
      runtime: new MockRuntime((q: AiRequest) => {
        prompts.push(q.pack.prompt);
        return "findings: []\n";
      }),
    });
    const p = prompts.find((x) => x.includes("business lens"))!;
    expect(p).not.toContain("recorded-by-people");
  });
});
