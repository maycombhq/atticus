import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { canAdvance } from "@maycombhq/changes";
import { Finding } from "@maycombhq/core";
import { CriticError, act, gateStatus, runCritic } from "../src/index.js";
import { CHANGE, FORGE_CHANGE, NOW, changeDir, forgeChangeRoot, readText } from "./helpers.js";

const replay = () =>
  ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), { now: () => new Date(NOW) });
const LATER = "2026-10-21T10:00:00Z";

async function idOf(root: string, rule: string, artifact?: string): Promise<string> {
  const s = await gateStatus(root, CHANGE, "plan");
  const f = s.findings.find(
    (x) => x.finding.rule === rule && (!artifact || x.finding.artifact === artifact),
  );
  if (!f) throw new Error(`no finding for ${rule}`);
  return f.finding.id;
}

describe("rounds, gates and actions", () => {
  it("records each action on its finding and enforces C3's rules", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, runtime: await replay() });

    // Apply: the pattern typo has a patch, and applying it fixes interfaces.md.
    const typo = await idOf(root, "constitution.interface-approved-pattern");
    expect(typo).toBe("interface-approved-pattern-interfaces-l6");
    const applied = await act(root, CHANGE, typo, "apply", { by: "ari", now: LATER });
    expect(applied.patched).toBe("interfaces.md");
    expect(applied.finding.state).toBe("applied");
    const ifaces = await readText(join(changeDir(root), "interfaces.md"));
    expect(ifaces).toContain(
      "| new | portal-bff | ledger-api | S.GW.SOR | GET /accounts/{id}/limit |",
    );
    expect(ifaces).not.toContain("S.GW.SRO");
    const stored = Finding.parse(parse(await readText(join(changeDir(root), applied.path))));
    expect(stored.resolution).toEqual({ action: "apply", by: "ari", at: LATER });

    // A finding is acted on once.
    await expect(act(root, CHANGE, typo, "apply", { by: "ari" })).rejects.toThrow(
      /already applied \(by ari\)/,
    );

    // Constitution findings can never be waived.
    const story = await idOf(root, "constitution.story-acceptance-criteria");
    await expect(act(root, CHANGE, story, "waive", { by: "tia", reason: "later" })).rejects.toThrow(
      /constitution rule \(constitution\.story-acceptance-criteria\), which can never be waived/,
    );
    // Only blocking findings can be waived.
    const rollback = await idOf(root, "design-has-rollback");
    await expect(act(root, CHANGE, rollback, "waive", { by: "tia", reason: "x" })).rejects.toThrow(
      /Only blocking findings can be waived/,
    );
    // Anyone may waive (ADR 0073): no role is checked. The waiver is a change to the finding's
    // file, recorded with the person, and reaches main through the hand-off PR.
    const race = await idOf(root, "design-concurrency-handled");
    await expect(act(root, CHANGE, race, "waive", { by: "ari" })).rejects.toThrow(
      /Waive needs a reason/,
    );
    const waived = await act(root, CHANGE, race, "waive", {
      by: "ari",
      reason: "The ledger library serialises transfers per account.",
      now: LATER,
    });
    expect(waived.finding.state).toBe("waived");
    expect(waived.finding.resolution).toMatchObject({ action: "waive", by: "ari" });
    expect(waived.message).toContain("reaches main with the plan hand-off PR");

    // Not relevant needs a reason; a knowledge gap can't be dismissed, only asked or answered.
    await expect(act(root, CHANGE, rollback, "not-relevant", { by: "dana" })).rejects.toThrow(
      /needs a reason/,
    );
    const dismissed = await act(root, CHANGE, rollback, "not-relevant", {
      by: "dana",
      reason: "Rollback is the platform default.",
      now: LATER,
    });
    expect(dismissed.finding.state).toBe("dismissed");
    const gap = await idOf(root, "vendor-contact-known");
    await expect(
      act(root, CHANGE, gap, "not-relevant", { by: "pat", reason: "x" }),
    ).rejects.toThrow(/knowledge gap: answer it with Ask/);
    const asked = await act(root, CHANGE, gap, "ask", { by: "bao", now: LATER });
    expect(asked.finding.resolution?.askedOf).toBe(asked.finding.question?.owner);
    expect(asked.finding.state).toBe("asked");

    // Unknown actions and findings.
    await expect(act(root, CHANGE, gap, "shrug", { by: "bao" })).rejects.toBeInstanceOf(
      CriticError,
    );
    await expect(act(root, CHANGE, "nope", "apply", { by: "bao" })).rejects.toThrow(
      /No finding nope/,
    );
  });

  it("refuses a patch that no longer applies or that touches another file", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW });
    const typo = await idOf(root, "constitution.interface-approved-pattern");
    const s = await gateStatus(root, CHANGE, "plan");
    const f = s.findings.find((x) => x.finding.id === typo)!.finding;
    const other = f.fix.patch!.replace(/interfaces\.md/g, "design.md");
    await expect(
      act(root, CHANGE, typo, "edit-and-apply", { by: "ari", edit: other }),
    ).rejects.toThrow(/a patch may only change its own artifact/);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(changeDir(root), "interfaces.md"), "# Interfaces\n\nrewritten\n");
    await expect(act(root, CHANGE, typo, "apply", { by: "ari" })).rejects.toThrow(
      /The patch doesn't apply: line \d+ is/,
    );
  });

  it("runs at most two rounds, carries decisions forward, and agrees with the lifecycle", async () => {
    const root = await forgeChangeRoot();
    const r1 = await runCritic(root, CHANGE, { now: NOW, runtime: await replay() });
    expect(r1.status.mayProceed).toBe(false);
    expect(r1.status.humanDecides).toBe(false);

    await act(root, CHANGE, await idOf(root, "constitution.interface-approved-pattern"), "apply", {
      by: "ari",
      now: LATER,
    });
    await act(root, CHANGE, await idOf(root, "design-concurrency-handled"), "waive", {
      by: "tia",
      reason: "The ledger library serialises transfers per account.",
      now: LATER,
    });
    await act(root, CHANGE, await idOf(root, "mappings-cover-interfaces"), "not-relevant", {
      by: "ari",
      reason: "risk-engine is being removed",
      now: LATER,
    });
    const gapId = await idOf(root, "slo-known");
    await act(root, CHANGE, gapId, "ask", { by: "bao", askedOf: "team-ledger", now: LATER });

    const r2 = await runCritic(root, CHANGE, { now: LATER, runtime: await replay() });
    expect(r2.round).toBe(2);
    // The typo is fixed, so it is gone; the rest of the same problems are found again.
    expect(r2.findings.some((f) => f.finding.summary.includes("S.GW.SRO"))).toBe(false);
    expect(r2.findings.length).toBe(r1.findings.length - 1);
    const carried = r2.findings
      .filter((f) => f.carried)
      .map((f) => [f.finding.rule, f.finding.state]);
    expect(carried.sort()).toEqual([
      ["design-concurrency-handled", "waived"],
      ["mappings-cover-interfaces", "dismissed"],
      ["slo-known", "asked"],
    ]);
    expect(r2.status.round).toBe(2);
    expect(r2.status.mayProceed).toBe(false);
    expect(r2.status.humanDecides).toBe(true);

    // The lifecycle's hand-off check reads the newest round the same way.
    const ready = await canAdvance(CHANGE, root);
    const blockers = ready.reasons
      .filter((x) => x.code === "blocking-finding" || x.code === "open-gap")
      .map((x) => x.finding);
    const open = r2.findings.filter(
      (f) =>
        f.finding.state === "open" &&
        (f.finding.severity === "blocking" || f.finding.severity === "gap"),
    );
    expect(blockers.sort()).toEqual(open.map((f) => f.finding.id).sort());
    expect(r2.status.reasons).toEqual(
      ready.reasons.filter((x) => x.code !== "no-handoff").map((x) => x.message),
    );

    // A third round is refused: a person decides now.
    await expect(runCritic(root, CHANGE, { now: LATER })).rejects.toThrow(
      /The plan gate has had 2 critic rounds, the most it allows\. A person decides now/,
    );
    // Acting on an old round is refused.
    await expect(
      act(root, CHANGE, "interface-approved-pattern-interfaces-l6", "apply", { by: "ari" }),
    ).rejects.toThrow(/is from round 1 of the plan gate; act on round 2, the newest/);
  });

  it("allows one checking round past the limit once a person acted on every blocking finding, and only one", async () => {
    // Kept well inside the timeout on a shared runner: the checking round is the critic's own rule
    // (layer 1 decides it), so the rounds run without the lenses, and the actions run at once.
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW });
    const r2 = await runCritic(root, CHANGE, { now: LATER });
    expect(r2.status.humanDecides).toBe(true);
    expect(r2.status.checkRound).toBe(false);
    const blocking = r2.findings.filter(
      (f) => f.finding.state === "open" && f.finding.severity === "blocking",
    );
    expect(blocking.length).toBeGreaterThan(1);

    // A person fixes one by hand, with no rounds left: the message says what really comes next.
    const first = await act(root, CHANGE, blocking[0]!.finding.id, "apply", {
      by: "ari",
      now: LATER,
    });
    expect(first.message).not.toContain("The next critic round checks");
    expect(first.message).toContain("no critic round is left");
    expect(first.message).toMatch(/act on the other \d+ blocking findings? of round 2/);
    await expect(runCritic(root, CHANGE, { now: LATER })).rejects.toThrow(
      /A person decides now: act on each blocking finding/,
    );

    // Every blocking finding of the newest round acted on by a person: one checking round.
    // The ones between act at once (each writes only its own finding's file); the last one, on
    // its own, sees every other acted on.
    await Promise.all(
      blocking
        .slice(1, -1)
        .map((f) => act(root, CHANGE, f.finding.id, "apply", { by: "ari", now: LATER })),
    );
    const last = await act(root, CHANGE, blocking.at(-1)!.finding.id, "apply", {
      by: "ari",
      now: LATER,
    });
    expect(last.message).toContain(
      `a person acted since round 2, so one more checking round is due: run atticus critic ${CHANGE} --gate plan`,
    );
    // The knowledge gaps still open are asked of their owners.
    await Promise.all(
      r2.findings
        .filter((f) => f.finding.state === "open" && f.finding.severity === "gap")
        .map((g) =>
          act(root, CHANGE, g.finding.id, "ask", {
            by: "bao",
            askedOf: "team-ledger",
            now: LATER,
          }),
        ),
    );
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.humanDecides).toBe(false);
    expect(s.checkRound).toBe(true);

    // The fixes weren't real, so the checking round finds them again: a person decides again.
    const r3 = await runCritic(root, CHANGE, { now: LATER });
    expect(r3.round).toBe(3);
    expect(r3.checkRound).toBe(true);
    const meta = parse(await readText(join(changeDir(root), "review/plan/3/meta/round.yaml"))) as {
      checkRound?: { after: number; actedOn: string[] };
    };
    expect(meta.checkRound?.after).toBe(2);
    // Every finding a person acted on since round 2 is recorded: the fixes and the gaps asked.
    const gaps = r2.findings.filter(
      (f) => f.finding.severity === "gap" && f.finding.state === "open",
    );
    expect(meta.checkRound?.actedOn.sort()).toEqual(
      [...blocking, ...gaps].map((f) => f.finding.id).sort(),
    );
    expect(r3.status.humanDecides).toBe(true);
    expect(r3.status.checkRound).toBe(false);
    await expect(runCritic(root, CHANGE, { now: LATER })).rejects.toThrow(/the most it allows/);
    // The longest test in this file: four critic runs and the actions between them. Its own
    // timeout, because the package's covers the rest; two minutes, as the suite allows, so the
    // parallel check on a shared two-CPU machine doesn't read slowness as a hang.
  }, 120_000);

  it("reports a gate with no rounds as open and refuses unknown gates", async () => {
    const root = await forgeChangeRoot();
    const s = await gateStatus(root, CHANGE, "design");
    expect(s.round).toBeUndefined();
    expect(s.mayProceed).toBe(true);
    await expect(gateStatus(root, CHANGE, "nowhere")).rejects.toThrow(/There is no gate nowhere/);
    await expect(runCritic(root, CHANGE, { gate: "nowhere" })).rejects.toThrow(
      /There is no gate nowhere/,
    );
    await expect(runCritic(root, "missing")).rejects.toThrow(/No change missing/);
  });

  it("runs only the asked lenses' findings, and the design gate only looks at design-phase artifacts", async () => {
    const root = await forgeChangeRoot();
    // An old lens's name asks the question that took it over (ADR 0124 addendum, Part 4).
    const story = await runCritic(root, CHANGE, { now: NOW, lenses: ["story"] });
    expect(new Set(story.findings.map((f) => f.finding.lens))).toEqual(new Set(["complete"]));
    const design = await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    expect(
      design.findings.some(
        (f) => f.finding.artifact.startsWith("stories") || f.finding.artifact === "snow.md",
      ),
    ).toBe(false);
    expect(design.findings.some((f) => f.finding.artifact === "interfaces.md")).toBe(true);
  });
});
