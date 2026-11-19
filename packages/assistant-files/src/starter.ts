import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The starter personas (ADR 0201, decision 7): seven role personas, a naysayer for each, and the
 * define-change skill that runs them, as plain Markdown. `atticus init` writes them into a new
 * org pack's `agents/` and `skills/`, and `atticus upgrade` adds them once to an existing one.
 * They are the organisation's from then on: it changes, copies or deletes them, and
 * `atticus skills write` writes each for Claude and Copilot. Atticus never reads this folder as
 * instructions of its own.
 */
export const STARTER_PERSONA_DIR = fileURLToPath(new URL("../starter", import.meta.url));

/** Every starter file, by its path in an org pack (`agents/qa.md`), in path order, LF. */
export async function starterPersonaFiles(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(join(STARTER_PERSONA_DIR, ...rel.split("/").filter(Boolean)), {
      withFileTypes: true,
    })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && e.name.endsWith(".md"))
        out.push({
          path: r,
          text: (await readFile(join(STARTER_PERSONA_DIR, ...r.split("/")), "utf8")).replace(
            /\r\n?/g,
            "\n",
          ),
        });
    }
  };
  await walk("");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
