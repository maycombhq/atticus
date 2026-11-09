/**
 * Path globs for the code tools, matched in linear time. Review round 49: the matcher moved to
 * @maycombhq/core, beside the walker of a checkout that reads every .gitignore line with it.
 */
export { globMatcher, type GlobMatcher } from "@maycombhq/core";
