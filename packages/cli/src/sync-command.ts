import {
  currentSignal,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
} from "@maycombhq/core";
import { estateRepos } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import type { AcpStepRunner } from "./copilot-acp-steps.js";
import * as all from "./map-all.js";
import { recipeStep } from "./map-commands.js";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";
import { factsRepos, verifyAllCommand } from "./verify-commands.js";

/**
 * ADR 0210 part 8, `atticus sync`: the repos whose clone moved past their facts (or never read)
 * read, recipe first and the model for the rest (map --all's plan and read; AI off, recipes
 * only), written once (verify --all --write: one build, the pairing inside it), Learn for the
 * types read, then what is open and the one next step. Never prompts; past the budget it stops.
 */
export async function syncCommand(
  root: string,
  o: { json?: boolean; maxTokens?: number },
  io: Output,
  deps: Pick<all.MapAllDeps, "runtime" | "git"> & { learnRunner?: AcpStepRunner } = {},
): Promise<number> {
  if (!isMetarepo(root)) return (io.err(notMetarepo(root)), 2);
  const op = await loadOrgPack(orgPackDirOf(root));
  const ai = all.modelModeAllowed(op) || !!deps.runtime;
  const say = io.progress ?? io.err;
  const steps: Output = { out: say, err: say, progress: say };
  const lim = await all.limitFor(root, op, o.maxTokens);
  const c0 = {
    limit: lim?.limit ?? 200_000,
    limitFrom: lim?.from ?? "flag",
    mode: "model",
  } as const;
  const plan = await all.planEstate(root, op, {}, c0, undefined);
  if (typeof plan === "string") return (io.err(plan), 2);
  const byModel = (i: all.PlanItem) => ai && !!lim && i.parts.length > 0;
  const waiting = new Set(
    plan.items.filter((i) => i.parts.length && !byModel(i)).map((i) => i.repo),
  );
  const by = (i: all.PlanItem) => (byModel(i) ? "model" : i.kind === "carry" ? "carry" : "recipe");
  const read = [
    ...plan.items.map((i) => ({ repo: i.repo, by: by(i) })),
    ...plan.skipped.filter((x) => x.recipe).map((x) => ({ repo: x.repo, by: "recipe" })),
  ].sort((a, b) => (a.repo < b.repo ? -1 : 1));
  const signal = currentSignal();
  if (read.some((r) => r.by === "model")) {
    const { runtimeForCli } = await import("@maycombhq/ai");
    const rt = { mode: "model", handoffValidate: async () => [] };
    const makeRuntime = async () => (await runtimeForCli(root, rt)).runtime;
    const mo = {
      mode: "model",
      join: false,
      resumeAs: "atticus sync",
      maxTokens: lim!.limit,
    } as const;
    const d = { makeRuntime, ...deps, ...(signal && { signal }) };
    if ((await all.mapAllCommand(root, mo, steps, d)) === 2) return 2;
  }
  // A repo nothing read (no recipe, and the model not here) is listed once: as waiting.
  const byRecipe = new Set<string>();
  for (const r of read.filter((x) => x.by === "recipe")) {
    const commit = await all.commitOf(root, r.repo);
    const at = { ...steps, out: (l: string) => (byRecipe.add(r.repo), say(l)) };
    if (commit && (await recipeStep(root, r.repo, commit, at, deps.git)) === 2) return 2;
  }
  const wait = [...waiting].filter((r) => !byRecipe.has(r));
  const done = read.filter((r) => r.by !== "recipe" || !wait.includes(r.repo));
  const onFile = await factsRepos(root);
  const only = onFile.filter((r) => read.some((x) => x.repo === r));
  let applied = 0;
  const onRepo = (_r: string, code: number) => void ((code === 0 || code === 3) && applied++);
  const c = all.capturedStep(io);
  const ask = { write: true, json: !!o.json, only, onRepo };
  const code = only.length ? await verifyAllCommand(root, ask, c) : 0;
  const removed: { kind: string; id: string }[] = [];
  for (const l of c.lines)
    if (!l.trimStart().startsWith("{")) (o.json ? say : io.out)(l);
    else removed.push(...((JSON.parse(l) as { removed?: [] }).removed ?? []));
  for (const l of c.errs) io.err(l);
  if (signal?.aborted) return code || 1; // stopped: what was said is the whole answer
  const types = estateRepos(op).flatMap((r) => (only.includes(r.id) && r.type ? [r.type] : []));
  if (applied && types.length) {
    // Learn proves each recipe first, with no model; it plans the model only where one is needed.
    const user = (await (await import("@maycombhq/workspace")).gitUser(root)).handle;
    const runner = deps.learnRunner ? { runner: deps.learnRunner } : {};
    const learn = { by: user, types: [...new Set(types)], ...runner, ...(signal && { signal }) };
    await (await import("./learn-recipes.js")).learnRecipes(root, learn, steps);
  }
  const rejected = [];
  for (const repo of onFile)
    for (const x of (await all.rejectionsOf(root, repo)).items) rejected.push({ repo, ...x });
  // The calls the join left loose, as the write's pairing reads them, asking no model here.
  const quiet = { op: { ...op, runtime: { ...op.runtime, ai: "off" as const } } };
  const a = await (await import("./apply-pair.js")).pairAsk(root, quiet).catch(() => undefined);
  const loose = a ? [...a.out.loose, ...a.send.map((s) => s.id)].sort() : [];
  const q = await listQuestions(root, { state: "open" }).catch(() => ({ questions: [] }));
  const open = q.questions.length;
  const next = rejected.length
    ? `Fix the rejected facts in ${factsRelOf(root)}/${rejected[0]!.repo}.rejected.jsonl, then run atticus sync again.`
    : waiting.size
      ? ai
        ? "Give the model's limit (atticus sync --max-tokens <n>) so the model reads what the recipes left."
        : "Turn AI on in org-pack/runtime.yaml (in a pull request), then run atticus sync again: the model reads what the recipes left."
      : loose.length
        ? "Pair the loose calls on the map's Connect (atticus ui --open), or say where each goes."
        : open
          ? "Answer what the code couldn't settle: atticus questions list --mine."
          : "Open the map: atticus ui --open.";
  const upToDate = !read.length;
  const written = applied > 0;
  const json = {
    upToDate,
    read: done,
    waiting: wait,
    written,
    rejected,
    removed,
    loose,
    open,
    next,
  };
  if (o.json) return (io.out(JSON.stringify(json, null, 2)), code);
  const rest = (r: string) => (waiting.has(r) ? ", the rest waiting for the model" : "");
  const how = (r: { repo: string; by: string }) =>
    `${r.repo} (by ${r.by === "carry" ? "carrying its facts" : r.by}${rest(r.repo)})`;
  const ai_ = ai ? "on, with no limit known" : "off here";
  for (const l of [
    upToDate
      ? "Up to date: every repo's facts are at its clone's commit. Nothing read, nothing written."
      : `Read: ${done.map(how).join(", ") || "nothing"}.`,
    ...(wait.length ? [`Waiting for the model (AI is ${ai_}): ${wait.join(", ")}.`] : []),
    ...(upToDate ? [] : [written ? "Written to the catalog once." : "Nothing written: see above."]),
    `Loose calls: ${loose.length ? `${loose.length}: ${loose.slice(0, 10).join(", ")}` : "none"}.`,
    `Rejected: ${rejected.length || "none"}.`,
    ...rejected.slice(0, 10).map((r) => `  ${r.repo} ${r.id ?? ""}: ${r.message}`),
    `Open: ${open} ${open === 1 ? "question" : "questions"}.`,
    `Next: ${next}`,
  ])
    io.out(l);
  return code;
}
