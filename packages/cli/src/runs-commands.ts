import type { Output } from "./commands.js";
import { listRuns, runTranscript } from "./runs-view.js";

/**
 * `atticus runs [--change id] [--limit n] [--json]` and `atticus runs show <run> [--json]`
 * (ADR 0106): what Atticus asked a model and what came back, from .runs/, the same as the app's
 * Model runs screen. Read-only.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export async function runsCli(
  root: string,
  o: { change?: string; limit?: number; json?: boolean },
  io: Output,
): Promise<number> {
  const runs = await listRuns(root, {
    ...(o.change ? { change: o.change } : {}),
    ...(o.limit ? { limit: o.limit } : {}),
  });
  if (o.json) {
    io.out(JSON.stringify({ runs }, null, 2));
    return 0;
  }
  if (!runs.length) {
    io.out(
      o.change ? `No model runs for ${o.change} yet.` : "No model runs yet: an AI step makes one.",
    );
    return 0;
  }
  for (const r of runs)
    io.out(
      [
        r.runId,
        r.change,
        r.agent,
        // ADR 0121 addendum: the kind of step, and the model that ran it when it is known.
        ...(r.stepClass ? [`${r.stepClass} step${r.model ? ` on ${r.model}` : ""}`] : []),
        `round ${r.attempt}`,
        r.state,
        r.answered ? "answered" : "no answer yet",
        ...(r.handedBack ? [`${plural(r.handedBack, "problem")} handed back`] : []),
        ...(r.toolCalls ? [`${plural(r.toolCalls, "tool call")}`] : []),
        when(r.startedAt),
      ].join("  "),
    );
  return 0;
}

export async function runShowCli(
  root: string,
  runId: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const t = await runTranscript(root, runId);
  if (!t) {
    io.err(`There is no run ${runId}. atticus runs lists them.`);
    return 2;
  }
  if (o.json) {
    io.out(JSON.stringify(t, null, 2));
    return 0;
  }
  const r = t.run;
  io.out(`${r.runId}: ${r.change}, ${r.agent}, round ${r.attempt}, ${r.state} (${r.runtime})`);
  if (r.stepClass)
    io.out(
      `Model: ${r.model ?? "not recorded"}, for a ${r.stepClass} step (the kind of step picks the model).`,
    );
  io.out(`Prompt: ${r.promptPath}${r.promptTokens ? ` (${r.promptTokens} tokens)` : ""}`);
  if (t.tools) {
    const calls = t.tools.calls;
    io.out(
      `Tools offered: ${t.tools.offered.join(", ") || "none"}; the model called them ${plural(calls.length, "time")}.`,
    );
    for (const c of calls) {
      io.out(
        `  Round ${c.round}: ${c.name} ${JSON.stringify(c.input)}${c.error ? " (refused)" : ""}, ${plural(c.tokens, "token")} back:`,
      );
      for (const l of c.output.trimEnd().split("\n")) io.out(`    ${l}`);
    }
    if (t.tools.stopped) io.out(`A cap stopped the tools: ${t.tools.stopped}.`);
  }
  // ADR 0116: how the run's context was retrieved, when a model helped.
  const ex = t.retrieval?.expansion;
  if (ex) {
    io.out(
      `The model read the input first${ex.run ? ` (run ${ex.run})` : ""}${ex.cached ? " (a kept answer)" : ""}: search terms ${ex.terms.join("; ") || "none"}.`,
    );
    for (const n of ex.names)
      io.out(
        `  ${n.name}: ${n.id ? `the index's ${n.id}` : n.new ? "new in this change" : "nothing in the index"} ("${n.quote}")`,
      );
    for (const d of ex.dropped) io.out(`  Left out: ${d.name}, ${d.why}.`);
  }
  const rr = t.retrieval?.rerank;
  if (rr)
    io.out(
      rr.used
        ? `The model ordered ${plural(rr.shown, "candidate")}${rr.run ? ` (run ${rr.run})` : ""}${rr.cached ? " (a kept answer)" : ""}: kept ${rr.order.join(", ") || "none"}; judged not needed: ${rr.dropped.join(", ") || "none"}.`
        : `The model's order of ${plural(rr.shown, "candidate")} named one it wasn't shown, so the engine's order stood.`,
    );
  if (t.retrieval?.meaning) io.out(`Meaning: ${t.retrieval.meaning}.`);
  for (const h of t.handedBack) {
    io.out(`Handed back after round ${h.attempt}:`);
    for (const p of h.problems) io.out(`  - ${p}`);
  }
  if (t.answer === undefined) io.out("Answer: none yet.");
  else {
    io.out("Answer:");
    for (const l of t.answer.trimEnd().split("\n")) io.out(`  ${l}`);
  }
  io.out(
    `Rounds of this step: ${t.rounds.map((x) => `${x.runId} (round ${x.attempt}, ${x.state})`).join(", ")}`,
  );
  return 0;
}
