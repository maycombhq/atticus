import { readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import { changeMapBody, changeMapOf } from "./change-map.js";
import { estimateOf } from "./change-estimate.js";

/**
 * A hand-off PR that reviews itself (WP7.4): the parts of the PR body an approver would
 * otherwise open the app for. What the change does as a picture (Mermaid, which GitHub and Azure
 * DevOps draw), its estimate as a range with what drives it, and the findings still open at its
 * gates, blocking first. Read from the change's files; nothing is worked out again.
 */

const days = (d: { p20: number; p50: number; p80: number }) =>
  `${d.p20}–${d.p80} days (most likely ${d.p50})`;

export async function handoffReview(root: string, change: string): Promise<string> {
  const lines: string[] = [];

  lines.push("### What it changes", "");
  const map = await changeMapOf(root, change).catch(() => undefined);
  if (map && map.flows > 0) {
    lines.push("```mermaid", changeMapBody(change, map).mermaid.trimEnd(), "```", "");
    lines.push(`From ${map.flows} target flow${map.flows === 1 ? "" : "s"} in ${map.source}.`, "");
  } else lines.push("No target flows yet: the architecture stage writes them.", "");

  lines.push("### Estimate", "");
  const est = await estimateOf(root, change).catch(() => undefined);
  if (est?.effort) {
    lines.push(days(est.effort), "");
    for (const d of est.drivers.filter((x) => x.count > 0).slice(0, 5))
      lines.push(`- ${d.what}: ${d.count}`);
    if (est.needsClass)
      lines.push(`- ${est.needsClass} unit${est.needsClass === 1 ? "" : "s"} not sized yet`);
    lines.push("");
  } else
    lines.push(
      est ? "Not sized yet: the org pack's estimates don't cover these units." : "Not sized yet.",
      "",
    );

  lines.push("### Findings still open", "");
  const gates = await reviewedGates(root, change).catch(() => [] as string[]);
  const open: { gate: string; severity: string; summary: string; id: string }[] = [];
  for (const gate of gates) {
    const rounds = await roundsOf(root, change, gate);
    if (!rounds.length) continue;
    for (const { finding: f } of (await readRound(root, change, gate, rounds.at(-1)!)).findings)
      if (f.state === "open")
        open.push({ gate, severity: f.severity, summary: f.summary, id: f.id });
  }
  if (!gates.length) lines.push("No gate has been reviewed yet.", "");
  else if (!open.length) lines.push("None open.", "");
  else {
    const order = ["blocking", "gap", "risk", "idea"];
    for (const f of open.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)))
      lines.push(`- **${f.severity}** (${f.gate}): ${f.summary} \`${f.id}\``);
    lines.push("");
  }
  return lines.join("\n");
}
