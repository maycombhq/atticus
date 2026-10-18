import type { GeneratedFile } from "../header.js";
import type { RepoTests, TestModel } from "../model.js";

/**
 * A test framework plugin: turns a story's test model for one repo into files. The generic
 * generators (Gherkin and the JSON test-case format) run for every repo; one concrete
 * generator is chosen per repo by its language and runner (or by --framework). Plugins are
 * pure: model in, files out, no network, no AI.
 */
export interface TestGenerator {
  id: string;
  version: string;
  /** Generic generators run for every repo; a concrete one is chosen per repo. */
  generic: boolean;
  /** Whether this concrete generator suits the repo (language, runner). */
  appliesTo(repo: RepoTests): boolean;
  render(model: TestModel, repo: RepoTests, ctx: RenderContext): GeneratedFile[];
}

export interface RenderContext {
  /** What the files are generated from, for their header (the story file, metarepo-relative). */
  source: string;
}

/** Where the generic files (feature, JSON cases) live in a repo of a language. */
export function layout(repo: RepoTests) {
  switch (repo.language) {
    case "java":
      return { features: "src/test/resources/features", json: "src/test/resources/atticus" };
    case "node":
      return { features: "test/features", json: "test/atticus" };
    default:
      return { features: "features", json: "atticus" };
  }
}
