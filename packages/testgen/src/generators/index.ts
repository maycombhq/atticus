import type { RepoTests } from "../model.js";
import { gherkinGenerator, jsonGenerator } from "./generic.js";
import { junitGenerator } from "./junit.js";
import { jestGenerator, vitestGenerator } from "./node.js";
import type { TestGenerator } from "./types.js";

export * from "./types.js";
export { gherkinGenerator, jsonGenerator, junitGenerator, jestGenerator, vitestGenerator };

/** The built-in generators: the generic ones first, then the concrete ones. */
export const BUILT_IN_GENERATORS: readonly TestGenerator[] = [
  gherkinGenerator,
  jsonGenerator,
  junitGenerator,
  vitestGenerator,
  jestGenerator,
];

/**
 * The generators for one repo: every generic one, plus the concrete one named by
 * `framework` (for every repo), else the first that suits the repo (plugins before built-ins).
 * `framework` "gherkin" or "json" means only the generic ones.
 */
export function generatorsFor(
  repo: RepoTests,
  o: { framework?: string; plugins?: readonly TestGenerator[] } = {},
): { generators: TestGenerator[]; note?: string } {
  const all = [...(o.plugins ?? []), ...BUILT_IN_GENERATORS];
  const generic = all.filter((g) => g.generic);
  const concrete = all.filter((g) => !g.generic);
  if (o.framework && ["gherkin", "json"].includes(o.framework)) return { generators: generic };
  if (o.framework) {
    const g = concrete.find((x) => x.id === o.framework);
    return { generators: g ? [...generic, g] : generic };
  }
  const g = concrete.find((x) => x.appliesTo(repo));
  return g
    ? { generators: [...generic, g] }
    : {
        generators: generic,
        ...(repo.repo
          ? {
              note: `No test framework suits ${repo.repo} (its language isn't known): only Gherkin and JSON were written.`,
            }
          : {}),
      };
}
