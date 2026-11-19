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

/** A folder's entries; none when the folder isn't there. Any other failure is thrown. */
const entries = (dir: string) =>
  readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });

/**
 * Every starter file, by its path in an org pack (`agents/qa.md`), in path order, LF. Only
 * `agents/<name>.md` and `skills/<name>/SKILL.md` are the starter: a README, a note beside a
 * skill or a file deeper down is never an org pack's. `dir` is the starter folder (tests give
 * their own); when it isn't there the error is the file system's (`ENOENT`).
 */
export async function starterPersonaFiles(
  dir: string = STARTER_PERSONA_DIR,
): Promise<{ path: string; text: string }[]> {
  // The folder itself must be there: a missing one is said, not read as an empty starter.
  await readdir(dir);
  const paths: string[] = [];
  for (const e of await entries(join(dir, "agents")))
    if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md")
      paths.push(`agents/${e.name}`);
  for (const e of await entries(join(dir, "skills")))
    if (
      e.isDirectory() &&
      (await entries(join(dir, "skills", e.name))).some((f) => f.isFile() && f.name === "SKILL.md")
    )
      paths.push(`skills/${e.name}/SKILL.md`);
  const out: { path: string; text: string }[] = [];
  for (const path of paths.sort())
    out.push({
      path,
      text: (await readFile(join(dir, ...path.split("/")), "utf8")).replace(/\r\n?/g, "\n"),
    });
  return out;
}
