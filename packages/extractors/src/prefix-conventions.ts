/**
 * Where common frameworks set a path prefix in front of every entry point, as data for
 * drafting a repo type (atticus repo-type new, ADR 0077). Framework knowledge lives here,
 * in the extractors package, so the core scanner stays neutral (ADR 0035): a convention is
 * offered only when the repo has its files, and a person edits the draft.
 */
export interface PrefixConvention {
  /** Files that show the convention may apply. */
  files: string[];
  /** A line one of those files must contain, when the files alone don't show it. */
  lineIncludes?: string;
  /** The prefix rule the draft gets: a config key, or a pattern whose first group is the prefix. */
  rule: { key?: string; pattern?: string; why: string };
  /** Source folders the prefix covers, kept only when the repo has them; else every file. */
  paths: string[];
}

export const PREFIX_CONVENTIONS: PrefixConvention[] = [
  {
    files: ["**/application*.properties", "**/application*.yml", "**/application*.yaml"],
    rule: { key: "server.servlet.context-path", why: "server.servlet.context-path" },
    paths: ["src/main/java/**", "src/main/kotlin/**"],
  },
  {
    files: ["**/main.ts"],
    lineIncludes: "setGlobalPrefix",
    rule: {
      pattern: "setGlobalPrefix\\(\\s*[\"']([^\"']+)[\"']",
      why: "the global prefix set at start-up",
    },
    paths: [],
  },
];
