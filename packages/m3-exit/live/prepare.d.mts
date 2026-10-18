export function prepare(
  outDir: string,
  options?: { runs?: number; log?: (line: string) => void },
): Promise<string[]>;
/** Files in a run folder that a grader owns (expected files, recordings, tests): empty when clean. */
export function leaks(dir: string): Promise<string[]>;
