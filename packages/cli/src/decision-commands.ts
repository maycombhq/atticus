import { parseArgs } from "node:util";
import { gitUser } from "@maycombhq/workspace";
import type { Api } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * ADR 0181: the AI's decisions from the terminal. `atticus questions decisions` lists what the AI
 * decided that stands, the counts split from code, by a person and by AI, the batches and whether
 * deciding is paused; `questions correct` records a person's correction and spreads it by a rule
 * (`--similar`, on by default; `--preview` first); `questions undo <batch>` undoes one batch.
 * `correct` and `undo` act as the person: a Copilot session can't run them (person-only.ts).
 */

export const DECISIONS_USAGE =
  "Usage: atticus questions decisions [--json], atticus questions correct <q-id | link:<repo>:<call>> --option <n> | --api <entry> --to <repo> | --none [--no-similar] [--match <rule>] [--preview] [--json], or atticus questions undo <batch> [--json]";

const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);

function printView(v: Api.DecisionsViewT, io: Output) {
  const d = v.decide;
  io.out(
    `Deciding: pairings ${d.now.links}, questions ${d.now.questions} (runtime.yaml decide: links ${d.configured.links}, questions ${d.configured.questions}, minPrecision ${pct(d.configured.minPrecision)}).`,
  );
  if (d.paused) io.out(`Paused: ${d.paused.why}`);
  const n = d.precision.right + d.precision.wrong;
  io.out(
    n
      ? `Sample audit of the AI's decisions: ${pct(d.precision.precision)} right (${d.precision.right} of ${n}; 95% interval ${pct(d.precision.low)} to ${pct(d.precision.high)}).`
      : "Sample audit of the AI's decisions: none answered yet (atticus verify audit <repo> draws them).",
  );
  const c = (x: Api.DecisionCountsT) =>
    `${x.fromCode} from code, ${x.byPerson} by a person, ${x.byAi} by AI${x.open !== undefined ? `, ${x.open} open` : ""}`;
  io.out(`Links (as last written): ${c(v.links.counts)}.`);
  io.out(`Questions: ${c(v.questions.counts)}.`);
  const items = [...v.links.items, ...v.questions.items];
  if (items.length) io.out("Detected by AI, standing:");
  for (const i of items)
    io.out(
      `  ${i.item}  ${i.what}  [${i.bar ?? "ai"}, run ${i.run}${i.batch ? `, ${i.batch}` : ""}]`,
    );
  if (v.batches.length) io.out("Batches, newest first:");
  for (const b of v.batches)
    io.out(
      `  ${b.id}  ${b.kind === "ai" ? "AI" : "a correction"} by ${b.by}: ${b.applied} applied, ${b.reverted} taken back${b.correction?.rule ? `, rule ${b.correction.rule.match}` : ""}${b.undone ? ` (undone by ${b.undone.by})` : ""}`,
    );
  for (const p of v.problems) io.err(`${p.file}: ${p.message}`);
}

export async function decisionsCli(
  root: string,
  argv: string[],
  io: Output,
  deps: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: "string" },
      json: { type: "boolean" },
      option: { type: "string" },
      api: { type: "string" },
      to: { type: "string" },
      none: { type: "boolean" },
      similar: { type: "boolean" },
      "no-similar": { type: "boolean" },
      match: { type: "string" },
      preview: { type: "boolean" },
    },
  });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const [, command, id] = positionals;
  const m = await import("./ai-decide.js");
  const fail = (e: unknown): number => {
    if (e instanceof m.DecideError) {
      io.err(e.message);
      return e.code === "not-found" ? 1 : 2;
    }
    throw e;
  };
  if (command === "decisions") {
    const v = await m.decisionsView(root);
    if (values.json === true) io.out(JSON.stringify(v, null, 2));
    else printView(v, io);
    return v.problems.length ? 1 : 0;
  }
  const by = async () => (await gitUser(root)).handle;
  if (command === "correct") {
    if (!id) {
      io.err(DECISIONS_USAGE);
      return 2;
    }
    const option = str(values.option);
    if (option !== undefined && !/^\d+$/.test(option)) {
      io.err("--option is a number, from 1.");
      return 2;
    }
    const req: Api.CorrectDecisionRequestT = {
      item: id,
      ...(option ? { option: Number(option) } : {}),
      ...(str(values.api) ? { api: str(values.api)! } : {}),
      ...(str(values.to) ? { repo: str(values.to)! } : {}),
      ...(values.none === true ? { none: true } : {}),
      similar: values["no-similar"] !== true,
      ...(str(values.match) ? { match: str(values.match)! } : {}),
      ...(values.preview === true ? { preview: true } : {}),
    };
    let r: Api.CorrectDecisionResultT;
    try {
      r = await m.correctDecision(root, req, {
        by: await by(),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      });
    } catch (e) {
      return fail(e);
    }
    if (values.json === true) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(
      `${r.written ? "Corrected" : "Would correct"} ${r.item}: ${r.answer}, as yours${r.batch ? ` (batch ${r.batch})` : ""}.`,
    );
    if (r.rule)
      io.out(
        `Apply to similar: ${r.rule.derived ? "the rule derived from it" : "your rule"} is ${r.rule.match} (${r.rule.kind}); give another with --match, or --no-similar for this one alone.`,
      );
    if (r.noRule) io.out(`Nothing spreads: ${r.noRule}.`);
    for (const s of r.spread)
      io.out(
        `  ${s.change}: ${s.item} ${s.what}${s.was ? ` (was ${s.was})` : ""}${s.now ? ` → ${s.now}` : ""}`,
      );
    if (r.rule)
      io.out(
        `${r.counts.applied} applied, ${r.counts.confirmed} confirmed, ${r.counts.replaced} replaced, ${r.counts.reverted} opened again.`,
      );
    if (r.makeRule)
      io.out(
        `This shape has been corrected ${r.makeRule.corrections} times: make it a reading rule so the next read gets it right (${r.makeRule.command ?? "the app's Make this a rule, on the pairing"}).`,
      );
    if (r.written) {
      io.out(`Then: ${r.verify.join("; ")}. Undo: atticus questions undo ${r.batch}.`);
      io.out(r.commit);
    } else io.out("Nothing written: run it again without --preview to save it.");
    return 0;
  }
  if (command === "undo") {
    if (!id) {
      io.err(DECISIONS_USAGE);
      return 2;
    }
    let r: Api.UndoBatchResultT;
    try {
      r = await m.undoBatch(root, id, {
        by: await by(),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      });
    } catch (e) {
      return fail(e);
    }
    if (values.json === true) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(`Undid ${r.batch}: ${r.removed} taken away, ${r.restored} put back.`);
    for (const s of r.skipped) io.out(`  ${s}`);
    if (r.verify.length) io.out(`Then: ${r.verify.join("; ")}.`);
    io.out(r.commit);
    return 0;
  }
  io.err(DECISIONS_USAGE);
  return 2;
}
