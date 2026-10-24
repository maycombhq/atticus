import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { ensureLocalIgnore } from "@maycombhq/core";

/**
 * The person's own file, never committed (ADR 0073): their digest settings and the changes they
 * watch (WP7.5). Older files may still hold `view` and `groups` (ADR 0044); they are ignored and
 * dropped on the next save.
 */

export const ME_FILE = ".atticus/me.yaml";

const MeNotify = z.object({
  /** Where the digest goes; default a direct message to the person. */
  channel: z.string().min(1).optional(),
  /** How often the person wants the digest; Atticus sends it only when they (or their own scheduled job) ask. */
  digest: z.enum(["off", "daily", "weekly"]).default("off"),
});

const MeFile = z.object({
  notify: MeNotify.optional(),
  /** Changes the person follows: the digest and the editors say how each is doing. */
  watch: z.array(z.string().min(1)).default([]),
});
export type MeFile = z.infer<typeof MeFile>;

export async function readMe(root: string): Promise<MeFile> {
  try {
    const r = MeFile.safeParse(parse(await readFile(join(root, ME_FILE), "utf8")) ?? {});
    return r.success ? r.data : { watch: [] };
  } catch {
    return { watch: [] };
  }
}

export async function writeMe(root: string, me: MeFile): Promise<void> {
  await ensureLocalIgnore(root);
  const file = join(root, ME_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    stringify({
      ...(me.notify ? { notify: me.notify } : {}),
      ...(me.watch.length ? { watch: [...new Set(me.watch)].sort() } : {}),
    }),
    "utf8",
  );
}
