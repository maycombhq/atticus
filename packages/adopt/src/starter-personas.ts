import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, listFiles } from "./files.js";

/**
 * The starter personas and the define-change skill (ADR 0201): plain Markdown shipped in the
 * assistant-files package's `starter/` folder, written into a new org pack's `agents/` and
 * `skills/` by `atticus init`, and into an existing one by `atticus upgrade` (the
 * `starter-personas` step). Organisation configuration once written: never replaced.
 */

/** The folders of the starter that are copied; anything else beside them is not the org pack's. */
const STARTER_FOLDERS = ["agents", "skills"];

/** Where the installed assistant-files package keeps its starter folder; undefined when it can't be found. */
export function starterPersonasDir(): string | undefined {
  try {
    return fileURLToPath(new URL("../starter", import.meta.resolve("@maycombhq/assistant-files")));
  } catch {
    return undefined;
  }
}

/**
 * Each starter file as its path in the org pack ("/"-separated) and its bytes, in path order:
 * whatever the starter's `agents/` and `skills/` hold. None when the folder isn't there.
 */
export async function starterPersonaFiles(
  dir: string | undefined = starterPersonasDir(),
): Promise<{ rel: string; bytes: Buffer }[]> {
  if (!dir) return [];
  const out: { rel: string; bytes: Buffer }[] = [];
  for (const folder of STARTER_FOLDERS)
    for (const f of await listFiles(join(dir, folder)).catch(() => [] as string[]))
      out.push({
        rel: `${folder}/${f}`,
        bytes: await readFile(join(dir, folder, ...f.split("/"))),
      });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Write each starter file into the org pack where no file is at its path, never over one that
 * is there. Returns what it wrote, org-pack-relative.
 */
export async function writeStarterPersonas(orgPack: string, dir?: string): Promise<string[]> {
  const written: string[] = [];
  for (const f of await starterPersonaFiles(dir ?? starterPersonasDir())) {
    const to = join(orgPack, ...f.rel.split("/"));
    if (await exists(to)) continue;
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, f.bytes, { flag: "wx" });
    written.push(f.rel);
  }
  return written;
}
