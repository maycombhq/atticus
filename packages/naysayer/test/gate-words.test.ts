import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { act, checkRoundRule, gateStatus, ownerWaitsLine, runCritic } from "../src/index.js";
import { CHANGE, FORGE_CHANGE, NOW, changeDir, forgeChangeRoot } from "./helpers.js";

/**
 * What a live run on a chat app found in the words a person reads after acting (ADR 0087
 * addendum): edit-and-apply named a file the person hadn't edited; change status said a person
 * decides while the stage said nothing blocking was open, for one open gap; and a stop and the
 * status said the checking round two different ways.
 */

const replay = () =>
  ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), { now: () => new Date(NOW) });
const LATER = "2026-10-21T10:00:00Z";
const ROUND3 = "2026-10-22T10:00:00Z";
const AFTER = "2026-10-22T11:00:00Z";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Rounds 1 and 2, then a checking round 3 with one open gap and nothing blocking. */
async function oneGapOpen() {
  const root = await forgeChangeRoot();
  await runCritic(root, CHANGE, { now: NOW, runtime: await replay() });
  const r2 = await runCritic(root, CHANGE, { now: LATER, runtime: await replay() });
  const blocking = r2.findings.filter((f) => f.finding.severity === "blocking");
  for (const f of blocking)
    await act(root, CHANGE, f.finding.id, "apply", { by: "ari", now: LATER });
  const gap = r2.findings.find((f) => f.finding.kind === "knowledge-gap")!;
  const dir2 = join(changeDir(root), "review/plan/2");
  const dir3 = join(changeDir(root), "review/plan/3");
  await cp(dir2, dir3, { recursive: true });
  for (const n of await readdir(dir3))
    if (n.endsWith(".yaml") && n !== `${gap.finding.id}.yaml`) await rm(join(dir3, n));
  const g = parse(await readFile(join(dir3, `${gap.finding.id}.yaml`), "utf8")) as object;
  await writeFile(
    join(dir3, `${gap.finding.id}.yaml`),
    stringify({ ...g, round: 3, state: "open", createdAt: ROUND3, resolution: undefined }),
  );
  const meta = parse(await readFile(join(dir3, "meta/round.yaml"), "utf8")) as object;
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
  return { root, gap: gap.finding.id, artifact: gap.finding.artifact };
}

describe("edit-and-apply names the files the person changed", () => {
  it("from the stage's write hashes: an edited target flow, not the finding's artifact", async () => {
    const { root, gap, artifact } = await oneGapOpen();
    const dir = changeDir(root);
    const flow = "target-flows/forge-payments.transfer.yaml";
    const was = "schemaVersion: 2\nflow: forge-payments.transfer\n";
    await mkdir(join(dir, "target-flows"), { recursive: true });
    await mkdir(join(dir, "stage"), { recursive: true });
    await writeFile(
      join(dir, "stage/architecture.yaml"),
      stringify({
        schemaVersion: 1,
        change: CHANGE,
        stage: "architecture",
        written: { [flow]: sha(was) },
      }),
    );
    await writeFile(join(dir, flow), `${was}# the owner, written in by hand\n`);
    expect(artifact).not.toBe(flow);
    const r = await act(root, CHANGE, gap, "edit-and-apply", {
      by: "ari",
      reason: "Wrote the owner into the target flow.",
      now: AFTER,
    });
    expect(r.message).toMatch(
      new RegExp(`^Recorded your edit to ${flow.replace(/\./g, "\\.")}[.;]`),
    );
  });

  it("without a stage's hashes, the finding's artifact", async () => {
    const { root, gap, artifact } = await oneGapOpen();
    const r = await act(root, CHANGE, gap, "edit-and-apply", {
      by: "ari",
      reason: "Wrote it in.",
      now: AFTER,
    });
    expect(r.message).toMatch(
      new RegExp(`^Recorded your edit to ${artifact.replace(/\./g, "\\.")}`),
    );
    // The checking round, in the one rule both a stop and the status state.
    expect(r.message).toContain(checkRoundRule(3));
    expect(checkRoundRule(3)).toBe(
      "a person acted since round 3, so one more checking round is due",
    );
  });
});

describe("an open gap waits on its owner, in the status and in the stage's done", () => {
  it("is not 'a person decides now': the gate's status says the gap waits on its owner and what the hand-off needs", async () => {
    const { root, gap } = await oneGapOpen();
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.open.blocking).toBe(0);
    expect(s.open.gaps).toBe(1);
    expect(s.mayProceed).toBe(false);
    expect(s.humanDecides).toBe(false);
    expect(ownerWaitsLine(s, CHANGE)).toBe(
      `Nothing blocking is open at the plan gate; 1 open gap waits on its owner, so the plan hand-off waits until it is answered: route it to its owner (atticus finding ${CHANGE} ${gap} ask --asked-of <owner>), or write the fact in and record it (atticus finding ${CHANGE} ${gap} edit-and-apply --reason "<what you wrote>").`,
    );
  });
});
