import {
  currentSignal,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
} from "@maycombhq/core";
import { estateRepos } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import * as all from "./map-all.js";
import { recipeStep } from "./map-commands.js";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";
import { factsRepos, verifyAllCommand } from "./verify-commands.js";

type Hooks = Pick<Parameters<typeof verifyAllCommand>[1], "onStart" | "onRepo" | "onStopped">;
export interface SyncOptions extends Hooks {
  json?: boolean;
  maxTokens?: number;
  /** The app's Apply: these repos (or all read) are written even when no commit moved. */
  apply?: readonly string[] | "all";
}
type Removed = { kind: string; id: string };
/** Learn's recipes for the types a sync read (`learnRecipes`, ADR 0210 part 2), once merged. */
export const syncHooks: { learn?: (root: string, types: string[], io: Output) => Promise<void> } =
  {};

/**
 * ADR 0210 part 8, `atticus sync`: the repos whose clone moved past their facts (or never read)
 * are read, recipe first and the model for the rest (`map --all`'s plan and reads; AI off, the
 * recipes only), then written once (`verify --all --write`: one build, the pairing inside it),
 * then what is open is said with the one next step. Never prompts; past the budget it stops first.
 */
export async function syncCommand(
  root: string,
  o: SyncOptions,
  io: Output,
  deps: Pick<all.MapAllDeps, "runtime" | "makeRuntime" | "signal" | "git"> = {},
): Promise<number> {
  if (!isMetarepo(root)) return (io.err(notMetarepo(root)), 2);
  const op = await loadOrgPack(orgPackDirOf(root));
  const ai = all.modelModeAllowed(op) || !!deps.runtime;
  const say = io.progress ?? io.err;
  const steps: Output = { out: say, err: say, progress: say };
  const lim = await all.limitFor(root, op, o.maxTokens);
  const plan = await all.planEstate(
    root,
    op,
    {},
    {
      limit: lim?.limit ?? 200_000,
      limitFrom: lim?.from ?? "flag",
      mode: ai ? "model" : "copilot",
    },
    undefined,
  );
  if (typeof plan === "string") return (io.err(plan), 2);
  const byModel = (i: all.PlanItem) => ai && !!lim && i.parts.length > 0;
  const waiting = plan.items.filter((i) => i.parts.length && !byModel(i)).map((i) => i.repo);
  const read = [
    ...plan.items.map((i) => ({
      repo: i.repo,
      by: byModel(i) ? "model" : i.kind === "carry" ? "carry" : "recipe",
    })),
    ...plan.skipped.filter((x) => x.recipe).map((x) => ({ repo: x.repo, by: "recipe" })),
  ].sort((a, b) => (a.repo < b.repo ? -1 : 1));
  if (read.some((r) => r.by === "model")) {
    const runtime = async () =>
      (
        await (
          await import("@maycombhq/ai")
        ).runtimeForCli(root, { mode: "model", handoffValidate: async () => [] })
      ).runtime;
    const mo = { mode: "model" as const, join: false as const, resumeAs: "atticus sync" };
    const code = await all.mapAllCommand(root, { ...mo, maxTokens: lim!.limit }, steps, {
      makeRuntime: runtime,
      ...deps,
    });
    if (code === 2) return 2;
  } else
    for (const r of read.filter((x) => x.by === "recipe")) {
      const commit = await all.commitOf(root, r.repo);
      if (commit && (await recipeStep(root, r.repo, commit, steps, deps.git)) === 2) return 2;
    }
  const onFile = await factsRepos(root);
  const want = new Set([
    ...read.map((r) => r.repo),
    ...(o.apply === "all" ? onFile : (o.apply ?? [])),
  ]);
  const only = onFile.filter((r) => want.has(r));
  let applied = 0;
  const onRepo: Hooks["onRepo"] = (repo, code, left) => {
    if (code === 0 || code === 3) applied++;
    o.onRepo?.(repo, code, left);
  };
  // Human mode prints verify's own lines (each removal with why); --json keeps them for CI.
  const c = all.capturedStep(io);
  const ask = { write: true, json: !!o.json, ...hooks(o), onRepo };
  const code =
    only.length || o.apply === "all"
      ? await verifyAllCommand(root, { ...ask, ...(o.apply === "all" ? {} : { only }) }, c)
      : 0;
  const js = c.lines.flatMap((l) => {
    if (!l.trimStart().startsWith("{")) return ((o.json ? say : io.out)(l), []);
    return [JSON.parse(l) as { removed?: Removed[] }];
  });
  for (const l of c.errs) io.err(l);
  if (currentSignal()?.aborted) return code; // stopped: what verify said is the whole answer
  const written = applied > 0;
  // The seam for Learn (item 5b): the repo types this sync read, after the one write.
  const read_ = new Set(read.map((r) => r.repo));
  const types = estateRepos(op).flatMap((r) => (read_.has(r.id) && r.type ? [r.type] : []));
  if (written && syncHooks.learn) await syncHooks.learn(root, [...new Set(types)].sort(), steps);
  const removed = [...new Map(js.flatMap((j) => j.removed ?? []).map((r) => [r.id, r])).values()];
  const rejected = [];
  for (const repo of onFile)
    for (const x of (await all.rejectionsOf(root, repo)).items) rejected.push({ repo, ...x });
  // The calls the join left loose, as the write's pairing reads them; asking no model here.
  const quiet = { op: { ...op, runtime: { ...op.runtime, ai: "off" as const } } };
  const a = await (await import("./apply-pair.js")).pairAsk(root, quiet).catch(() => undefined);
  const loose = a ? [...a.out.loose, ...a.send.map((s) => s.id)].sort() : [];
  const open = (await listQuestions(root, { state: "open" }).catch(() => ({ questions: [] })))
    .questions.length;
  const next = rejected.length
    ? `Fix the rejected facts in ${factsRelOf(root)}/${rejected[0]!.repo}.rejected.jsonl, then run atticus sync again.`
    : waiting.length
      ? ai
        ? `Give the model's limit (atticus sync --max-tokens <n>) so the model reads what the recipes left.`
        : "Turn AI on in org-pack/runtime.yaml (in a pull request), then run atticus sync again: the model reads what the recipes left."
      : loose.length
        ? "Pair the loose calls on the map's Connect (atticus ui --open), or say where each goes."
        : open
          ? "Answer what the code couldn't settle: atticus questions list --mine."
          : "Open the map: atticus ui --open.";
  const upToDate = !read.length && !o.apply;
  const result = { upToDate, read, waiting, written, rejected, removed, loose, open, next };
  if (o.json) io.out(JSON.stringify(result, null, 2));
  else
    for (const l of [
      upToDate
        ? "Up to date: every repo's facts are at its clone's commit. Nothing read, nothing written."
        : `Read: ${read.map((r) => `${r.repo} (by ${r.by === "carry" ? "carrying its facts" : r.by})`).join(", ") || "nothing"}.`,
      ...(waiting.length
        ? [
            `Waiting for the model (AI is ${ai ? "on, with no limit known" : "off here"}): ${waiting.join(", ")}.`,
          ]
        : []),
      ...(upToDate
        ? []
        : [written ? "Written to the catalog once." : "Nothing written: see above."]),
      `Loose calls: ${loose.length ? `${loose.length}: ${loose.slice(0, 10).join(", ")}` : "none"}.`,
      `Rejected: ${rejected.length ? rejected.length : "none"}.`,
      ...rejected.slice(0, 10).map((r) => `  ${r.repo} ${r.id ?? ""}: ${r.message}`),
      `Open: ${open} ${open === 1 ? "question" : "questions"}.`,
      `Next: ${next}`,
    ])
      io.out(l);
  return code;
}

const hooks = (o: Hooks): Hooks => ({
  ...(o.onStart ? { onStart: o.onStart } : {}),
  ...(o.onRepo ? { onRepo: o.onRepo } : {}),
  ...(o.onStopped ? { onStopped: o.onStopped } : {}),
});
