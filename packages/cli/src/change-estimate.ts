import { relative, sep } from "node:path";
import { detectConflicts } from "@maycombhq/changes";
import { loadEstimates, orgPackDirOf, type Api } from "@maycombhq/core";
import { gateStatus, reviewedGates } from "@maycombhq/naysayer";
import {
  estimateChange,
  loadRelease,
  releaseForecast,
  type EstimateFlow,
} from "@maycombhq/release";
import { targetFlowsOf } from "./change-map.js";
import type { Output } from "./commands.js";

/**
 * A change's estimate (ADR 0109), from the files only: its target flows, the org pack's
 * estimates.yaml, its open blocking findings, the other open changes on the same parts, and the
 * waiting the release forecast finds. No AI, no network: the same files give the same estimate.
 */

/** The estimate's body; undefined when there is no such change. */
export async function estimateOf(
  root: string,
  change: string,
  o: { now?: string } = {},
): Promise<Api.ChangeEstimateT | undefined> {
  const t = await targetFlowsOf(root, change);
  if (!t) return undefined;
  const problems = [...t.problems];
  const { estimates, problem } = await loadEstimates(orgPackDirOf(root));
  if (problem) problems.push(problem);

  // A component's boundary is its system's; a vendor can be a system with no components.
  const systems = new Map<string, string | undefined>();
  const systemOf = new Map<string, string>();
  for (const r of t.records) {
    if (r.kind === "System") systems.set(r.id, (r as { boundary?: string }).boundary);
    if (r.kind === "Component") systemOf.set(r.id, (r as { system: string }).system);
  }
  const boundaryOf = (c: string) => systems.get(systemOf.get(c) ?? c);

  let openBlocking = 0;
  for (const gate of await reviewedGates(root, change).catch(() => [] as string[]))
    openBlocking += await gateStatus(root, change, gate).then(
      (s) => s.open.blocking,
      () => 0,
    );
  const conflicts = (await detectConflicts(root).catch(() => [])).filter((p) =>
    p.changes.includes(change),
  ).length;
  let waitDays: number | undefined;
  try {
    const f = await releaseForecast(await loadRelease(root, change, o.now ? { now: o.now } : {}));
    if (f.status !== "released") waitDays = f.waitDays;
  } catch (e) {
    problems.push(
      `The release forecast couldn't be worked out: ${(e as Error).message.split("\n")[0]}`,
    );
  }

  const flows: EstimateFlow[] = t.merged.map((m) => ({
    flow: m.flow,
    repo: m.repo,
    change: m.change,
    trigger: m.trigger.kind,
    file: `${t.source}/${m.flow}.yaml`,
    steps: m.steps.map((s) => ({
      mark: s.mark,
      kind: s.kind,
      ...(s.today !== undefined ? { today: s.today } : {}),
      ...(s.target !== undefined ? { target: s.target } : {}),
      ...(s.what ? { what: s.what } : {}),
      ...(s.to ? { to: s.to } : {}),
      ...(s.store ? { store: s.store } : {}),
      ...(s.confirmedBy ? { confirmedBy: s.confirmedBy } : {}),
    })),
  }));
  const e = estimateChange({
    change,
    flows,
    ...(estimates ? { table: estimates } : {}),
    boundaryOf,
    openBlocking,
    conflicts,
    ...(waitDays !== undefined ? { waitDays } : {}),
  });
  return {
    ...e,
    title: t.title,
    source: t.source,
    ...(estimates
      ? { table: `${relative(root, orgPackDirOf(root)).split(sep).join("/")}/estimates.yaml` }
      : {}),
    problems,
  };
}

const range = (d: { p20: number; p50: number; p80: number }) =>
  `${d.p20}-${d.p80} days (p50 ${d.p50})`;

/** atticus change estimate <change> [--json]. Exit 0 estimated (or sized), 1 nothing to size yet, 2 no such change. */
export async function changeEstimateCommand(
  root: string,
  change: string,
  o: { json?: boolean; now?: string },
  io: Output,
): Promise<number> {
  const e = await estimateOf(root, change, o.now ? { now: o.now } : {});
  if (!e) {
    io.err(`There is no change ${change}.`);
    return 2;
  }
  if (o.json) {
    io.out(JSON.stringify(e, null, 2));
    return 0;
  }
  for (const p of e.problems) io.err(p);
  if (!e.units.length) {
    io.err(
      `${change} has no target flows yet, so there is nothing to size: the architecture stage writes them (atticus change architecture ${change}).`,
    );
    return 1;
  }
  io.out(`Estimate for ${change}: ${e.title}`);
  io.out(
    e.effort
      ? `Effort: ${range(e.effort)}, from ${e.units.length - e.needsClass} of ${e.units.length} units of work.`
      : `Size: ${e.units.length} units of work. No days: ${e.table ? "no class in the org pack's estimates.yaml matches them" : "the org pack has no estimates.yaml"}.`,
  );
  if (e.calendar.waitDays !== undefined)
    io.out(
      `Waiting (the release forecast): ${e.calendar.waitDays} working days${e.calendar.longer ? `; the ${e.calendar.longer} is longer` : ""}.`,
    );
  io.out(
    e.calibration.source
      ? `Not calibrated yet: the ranges are ${e.calibration.source}'s, from ${e.table}.`
      : "Not calibrated yet.",
  );
  if (e.drivers.length) {
    io.out("Drivers:");
    for (const d of e.drivers)
      io.out(
        `  ${d.what}: ${d.count}${d.widens ? ` (widens the upper end by ${d.widens}x)` : ""}${d.source ? `  ${d.source}` : ""}`,
      );
  }
  io.out("Work:");
  for (const u of e.units)
    io.out(
      `  ${u.repo}  ${u.flow}${u.step !== undefined ? ` step ${u.step}` : ""}  ${u.class}  ${u.days ? range(u.days) : "needs a class"}  ${u.what}`,
    );
  return 0;
}
