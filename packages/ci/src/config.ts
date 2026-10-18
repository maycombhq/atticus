import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The org pack's CI settings, `process/ci.yaml` (optional; every field has a default):
 *
 *   schemaVersion: 1
 *   drift:
 *     mode: block        # block: drift fails the pipeline (exit 1); warn: it is reported only
 *     ignore: []         # record ids to leave out; a trailing * matches a prefix
 *   archive:
 *     requireMergedPrs: true
 *
 * Like `process/change-policy.yaml`, it sits beside the C6 files and is read with its own
 * schema until it is promoted into C6 (a candidate additive contract change).
 */
export const CiConfig = z.strictObject({
  schemaVersion: z.literal(1),
  drift: z
    .strictObject({
      mode: z.enum(["block", "warn"]).default("block"),
      ignore: z.array(z.string().min(1)).default([]),
    })
    .default({ mode: "block", ignore: [] }),
  archive: z
    .strictObject({ requireMergedPrs: z.boolean().default(true) })
    .default({ requireMergedPrs: true }),
});
export type CiConfig = z.infer<typeof CiConfig>;

export const DEFAULT_CI_CONFIG: CiConfig = CiConfig.parse({ schemaVersion: 1 });

export async function loadCiConfig(
  orgPackDir: string | undefined,
): Promise<{ config: CiConfig; problems: string[] }> {
  if (!orgPackDir) return { config: DEFAULT_CI_CONFIG, problems: [] };
  let text: string;
  try {
    text = await readFile(join(orgPackDir, "process", "ci.yaml"), "utf8");
  } catch {
    return { config: DEFAULT_CI_CONFIG, problems: [] };
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return {
      config: DEFAULT_CI_CONFIG,
      problems: [
        `org-pack/process/ci.yaml: can't read YAML: ${(e as Error).message.split("\n")[0]}`,
      ],
    };
  }
  const r = CiConfig.safeParse(data);
  if (!r.success)
    return {
      config: DEFAULT_CI_CONFIG,
      problems: r.error.issues.map(
        (i) => `org-pack/process/ci.yaml: ${i.path.join(".") || "(file)"}: ${i.message}`,
      ),
    };
  return { config: r.data, problems: [] };
}

/** True when an id matches an ignore pattern (exact, or a prefix ending in *). */
export function ignored(id: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p));
}
