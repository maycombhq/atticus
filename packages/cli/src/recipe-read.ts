import { runRecipe, type Fact, type RecipeDropped } from "@maycombhq/core";
import { globToRegExp } from "@maycombhq/sdk";
import type { FileSource } from "@maycombhq/verify";
import { ruleMatches, type EffectiveRule, type EffectiveRules } from "./reading-rules.js";

/**
 * ADR 0210 part 2, "recipe first, model on request": the active rules with a recipe read the
 * files they name with no model; the model is given only the rest. A recipe is data the one
 * engine in core runs (`runRecipe`), never code.
 */
export const recipesOf = (e: Pick<EffectiveRules, "rules">): EffectiveRule[] =>
  e.rules.filter((r) => r.extract);

/** The files the recipes read: those a recipe names, the repo's exclusions left out. */
export function recipeFiles(
  source: FileSource,
  exclude: readonly string[],
  recipes: readonly EffectiveRule[],
): string[] {
  if (!recipes.length) return [];
  const out = exclude.map(globToRegExp);
  return source
    .list()
    .filter((p) => !out.some((re) => re.test(p)) && recipes.some((r) => ruleMatches(r, p)));
}

/** A source without the files the recipes read: what the model is planned over. */
export function withoutFiles(source: FileSource, paths: readonly string[]): FileSource {
  if (!paths.length) return source;
  const gone = new Set(paths);
  return {
    list: () => source.list().filter((p) => !gone.has(p)),
    read: (p) => source.read(p),
    ...(source.size ? { size: (p: string) => source.size!(p) } : {}),
  };
}

/** A fact a recipe wrote: `by: reader`, its id `<kind>.<rule key>.<12 hex>` (any key, renamed too). */
const byARecipe = (f: Fact) => f.by === "reader" && /^[a-z]+\.[a-z0-9-]+\.[0-9a-f]{12}$/.test(f.id);

/** What the recipes read of a repo, and what is left on file beside it. */
export interface RecipePlan {
  /** The files the recipes read, never the model's. */
  files: string[];
  facts: Fact[];
  dropped: RecipeDropped[];
  /** The facts on file kept: none a recipe wrote, none citing a file the recipes read. */
  kept: Fact[];
}

/**
 * The recipes' facts at a commit (review of item 7). A file is the recipes' only when they wrote
 * a fact from it and every fact the last read wrote there is of a kind they write; any other file
 * a recipe names goes to the model whole, and nothing a recipe found there is written.
 */
export function recipePlan(
  recipes: readonly EffectiveRule[],
  source: FileSource,
  exclude: readonly string[],
  at: { repo: string; commit: string },
  existing: readonly Fact[],
): RecipePlan {
  const named = recipeFiles(source, exclude, recipes);
  const texts = named.flatMap((path) => {
    const text = source.read(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const all: Fact[] = [];
  const dropped: RecipeDropped[] = [];
  for (const r of recipes) {
    const got = runRecipe(r, texts, at);
    all.push(...got.facts);
    dropped.push(...got.dropped);
  }
  const kinds = new Set(recipes.map((r) => r.extract!.fact));
  const wrote = new Set(all.map((f) => f.cite.file));
  const files = named.filter(
    (p) =>
      wrote.has(p) && existing.every((f) => f.cite.file !== p || byARecipe(f) || kinds.has(f.kind)),
  );
  const mine = new Set(files);
  return {
    files,
    facts: all.filter((f) => mine.has(f.cite.file)),
    dropped: dropped.filter((d) => mine.has(d.file)),
    kept: existing.filter((f) => !byARecipe(f) && !mine.has(f.cite.file)),
  };
}
