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

/**
 * The recipes' facts at a commit, and the facts on file they replace: a recipe's own earlier
 * facts (`by: reader`, its id `<kind>.<key>.`), so a line that no longer matches drops its fact.
 */
export function recipeFacts(
  recipes: readonly EffectiveRule[],
  files: readonly string[],
  source: FileSource,
  at: { repo: string; commit: string },
  existing: readonly Fact[],
): { facts: Fact[]; dropped: RecipeDropped[]; kept: Fact[] } {
  const texts = files.flatMap((path) => {
    const text = source.read(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const facts: Fact[] = [];
  const dropped: RecipeDropped[] = [];
  for (const r of recipes) {
    const got = runRecipe(r, texts, at);
    facts.push(...got.facts);
    dropped.push(...got.dropped);
  }
  const mine = recipes.map((r) => `${r.extract!.fact}.${r.key}.`);
  const kept = existing.filter((f) => !(f.by === "reader" && mine.some((m) => f.id.startsWith(m))));
  return { facts, dropped, kept };
}
