import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Finding } from "@maycombhq/core";
import { act, gateStatus, runCritic } from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, readText } from "./helpers.js";

const LATER = "2026-10-21T10:00:00Z";
const GAP = "gap-slo-known-ledger";
const ISSUE = "data-retention-stated-data-l8";

describe("one finding at several gates", () => {
  it("carries an asked owner question to a later gate and links to the earlier one", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    const asked = await act(root, CHANGE, GAP, "ask", { by: "ari", now: NOW });
    expect(asked.path).toBe(`review/design/1/${GAP}.yaml`);

    const plan = await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    const again = plan.findings.find((f) => f.finding.id === GAP)!;
    expect(again.carried).toBe(true);
    expect(again.finding.state).toBe("asked");
    expect(again.finding.resolution).toMatchObject({
      action: "ask",
      by: "ari",
      askedOf: asked.finding.resolution?.askedOf,
    });
    expect(again.finding.resolution?.reason).toBe(
      `Already asked at the design gate: see review/design/1/${GAP}.yaml.`,
    );
    // The question stops blocking at the plan gate too; other gaps stay open.
    const status = await gateStatus(root, CHANGE, "plan");
    expect(status.findings.find((f) => f.finding.id === GAP)?.finding.state).toBe("asked");
    const other = plan.findings.find((f) => f.finding.id === "gap-slo-known-portal")!;
    expect(other.finding.state).toBe("open");
    expect(other.carried).toBe(false);
    // Asking again says so, with the link, and writes nothing new.
    await expect(act(root, CHANGE, GAP, "ask", { by: "tia" })).rejects.toThrow(
      /already asked \(by ari\).*review\/design\/1\/gap-slo-known-ledger\.yaml/,
    );
    const stored = Finding.parse(parse(await readText(join(changeDir(root), again.path))));
    expect(stored.resolution?.by).toBe("ari");
  });

  it("carries a person's decision across gates (W2): a dismissed issue stays dismissed, with a link to where it was decided, and a question nobody asked stays open", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    await act(root, CHANGE, ISSUE, "not-relevant", { by: "ari", reason: "Not ours", now: NOW });
    const plan = await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    const issue = plan.findings.find((f) => f.finding.id === ISSUE)!;
    expect(issue.finding.state).toBe("dismissed");
    expect(issue.carried).toBe(true);
    expect(issue.finding.resolution).toMatchObject({ action: "not-relevant", by: "ari", at: NOW });
    expect(issue.finding.resolution?.reason).toBe(
      `Not ours (decided at the design gate: see review/design/1/${ISSUE}.yaml)`,
    );
    expect(plan.findings.find((f) => f.finding.id === GAP)?.finding.state).toBe("open");
    // Carried again to a later round, the link isn't stacked.
    const again = await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    expect(again.findings.find((f) => f.finding.id === ISSUE)!.finding.resolution?.reason).toBe(
      `Not ours (decided at the design gate: see review/design/1/${ISSUE}.yaml)`,
    );
  });

  it("carries a fact a person wrote in for a gap (edit-and-apply with a reason) to a later gate, but not a fix that didn't take", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    await act(root, CHANGE, GAP, "edit-and-apply", {
      by: "ari",
      reason: "The ledger's SLO is 99.9% monthly; wrote it into design.md.",
      now: NOW,
    });
    await act(root, CHANGE, ISSUE, "apply", { by: "ari", now: NOW });
    const plan = await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    const gap = plan.findings.find((f) => f.finding.id === GAP)!;
    expect(gap.finding.state).toBe("applied");
    expect(gap.carried).toBe(true);
    expect(gap.finding.resolution?.by).toBe("ari");
    // A fix applied that the next gate still finds didn't take: it is raised again.
    const issue = plan.findings.find((f) => f.finding.id === ISSUE)!;
    expect(issue.finding.state).toBe("open");
    expect(issue.carried).toBe(false);
  });

  it("acts on the copy from the latest round across gates when no gate is given", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    const r = await act(root, CHANGE, ISSUE, "not-relevant", {
      by: "ari",
      reason: "Retention is the platform default.",
      now: LATER,
    });
    expect(r.path).toBe(`review/plan/1/${ISSUE}.yaml`);
    // The design copy is untouched, and a gate can still be named.
    const design = await act(root, CHANGE, ISSUE, "not-relevant", {
      by: "ari",
      reason: "Same reason.",
      gate: "design",
      now: LATER,
    });
    expect(design.path).toBe(`review/design/1/${ISSUE}.yaml`);
    await expect(
      act(root, CHANGE, ISSUE, "not-relevant", { by: "ari", reason: "x" }),
    ).rejects.toThrow(/already dismissed/);
  });

  it("takes the gate that ran most recently, and the later gate when both ran at the same moment", async () => {
    const a = await forgeChangeRoot();
    await runCritic(a, CHANGE, { now: LATER, gate: "design" });
    await runCritic(a, CHANGE, { now: NOW, gate: "plan" });
    expect((await act(a, CHANGE, ISSUE, "not-relevant", { by: "ari", reason: "r" })).path).toBe(
      `review/design/1/${ISSUE}.yaml`,
    );
    const b = await forgeChangeRoot();
    await runCritic(b, CHANGE, { now: NOW, gate: "design" });
    await runCritic(b, CHANGE, { now: NOW, gate: "plan" });
    expect((await act(b, CHANGE, ISSUE, "not-relevant", { by: "ari", reason: "r" })).path).toBe(
      `review/plan/1/${ISSUE}.yaml`,
    );
  });

  it("refuses an old round when no gate has the finding in its newest round", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, gate: "plan" });
    await act(root, CHANGE, "interface-approved-pattern-interfaces-l6", "apply", { by: "ari" });
    await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    await expect(
      act(root, CHANGE, "interface-approved-pattern-interfaces-l6", "apply", { by: "ari" }),
    ).rejects.toThrow(/is from round 1 of the plan gate; act on round 2, the newest/);
  });
});
