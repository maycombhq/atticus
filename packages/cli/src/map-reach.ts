import { estimateTokens, neutralise, wrapData } from "@maycombhq/ai";
import type { Conventions, Fact } from "@maycombhq/core";
import {
  NOT_REACHED_WHY,
  planBatches,
  reachableModels,
  readingRank,
  type FileSource,
  type Reachability,
} from "@maycombhq/verify";
import type { ModelsMode, NotReachedT } from "./map-parts.js";

/**
 * ADR 0169: reachable-first reading of model classes, as every planning command applies it: the
 * estimate and its parts, a first read in batches, `--gaps` and the rules top-up. One place says
 * what is read first, what is left out (and recorded, never silently), and how the reader is told.
 */

export interface ReachPlan {
  mode: ModelsMode;
  reach: Reachability;
  /** Read right after the build and config files: the entry points and clients, then the reached models. */
  first: string[];
  /** The model files left out: none under `--models all` or when nothing roots the reach. */
  leaveOut: string[];
  /** The plan's record of them, with their tokens; undefined when none is left out. */
  notReached?: NotReachedT;
}

/** The source files a read plans (excluded ones out), in reading order. */
export function readPathsOf(
  source: FileSource,
  exclude: readonly string[],
  conventions?: Conventions,
): string[] {
  return planBatches(source, {
    room: Number.MAX_SAFE_INTEGER,
    exclude,
    ...(conventions ? { conventions } : {}),
  })
    .batches.flat()
    .map((x) => x.path);
}

/** The reach over `paths` (the files the read plans), and what the mode makes of it. */
export function reachPlanOf(o: {
  paths: readonly string[];
  source: FileSource;
  facts?: readonly Fact[];
  mode: ModelsMode;
}): ReachPlan {
  const reach = reachableModels({
    paths: o.paths,
    read: (p) => o.source.read(p),
    ...(o.facts?.length ? { facts: o.facts } : {}),
  });
  const leaveOut = o.mode === "all" ? [] : reach.notReached;
  const tokens = leaveOut.reduce((n, p) => n + estimateTokens(o.source.read(p) ?? ""), 0);
  return {
    mode: o.mode,
    reach,
    first: [...reach.roots, ...reach.reached.map((r) => r.path)],
    leaveOut,
    ...(leaveOut.length
      ? { notReached: { why: NOT_REACHED_WHY, files: [...leaveOut], tokens } }
      : {}),
  };
}

/** The head of the read: the build and config files, the entry points and clients. */
export const reachHeadOf = (paths: readonly string[], r: ReachPlan): string[] => {
  const roots = new Set(r.reach.roots);
  return paths.filter((p) => readingRank(p) <= 1 || roots.has(p));
};


/** The summary line: how many model classes, how many reached, how many left out. */
export function modelsLine(repo: string, r: ReachPlan): string | undefined {
  const { reach } = r;
  if (!reach.models) return undefined;
  if (!reach.rooted)
    return `Model classes (ADR 0169): ${reach.models}; no entry point, client or fact to reach them from, so every one is read.`;
  const reached = `${reach.reached.length} reached from the entry points and calls, read after them`;
  if (r.mode === "all")
    return `Model classes (ADR 0169): ${reach.models}, every one read (--models all); ${reached}.`;
  return `Model classes (ADR 0169): ${reach.models}; ${reached}${r.leaveOut.length ? `; ${r.leaveOut.length} no entry or call reaches, left out: atticus map ${repo} --models all reads them` : ""}.`;
}

export { MODELS_RULE } from "@maycombhq/assistant-files";

/** Paths grouped by folder: `dir/: A.java, B.java`, a line each. */
function grouped(paths: readonly string[]): string[] {
  const by = new Map<string, string[]>();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const d = i < 0 ? "" : p.slice(0, i + 1);
    by.set(d, [...(by.get(d) ?? []), p.slice(i + 1)]);
  }
  return [...by.entries()].map(([d, fs]) => `- ${d || "./"}: ${fs.join(", ")}`);
}

/**
 * The data block a reader gets (rule 6: the paths and type names are the repo's text): each
 * reached model class with the names it declares and where it is reached from, then the ones
 * left out, by folder. `only` limits the reached ones to a batch's or session's files.
 */
export function modelsData(
  repo: string,
  r: ReachPlan,
  o: { only?: ReadonlySet<string>; origin?: string } = {},
): string | undefined {
  if (!r.reach.models || !r.reach.rooted) return undefined;
  const reached = r.reach.reached.filter((x) => !o.only || o.only.has(x.path));
  if (!reached.length && (o.only || !r.leaveOut.length)) return undefined;
  const lines = [
    ...(reached.length ? ["Reached (read these, and write their fields):"] : []),
    ...reached.map((x) => `- ${x.path} (${x.types.join(", ")}), from ${x.from}`),
    ...(r.leaveOut.length && !o.only
      ? [
          "Not reached by any entry point or call (left out; don't read them):",
          ...grouped(r.leaveOut),
        ]
      : []),
  ];
  return wrapData(
    { id: `${repo}.models`, kind: "models", origin: o.origin ?? "atticus/reachable" },
    neutralise(lines.join("\n"), undefined, { mark: true }).text,
  );
}
