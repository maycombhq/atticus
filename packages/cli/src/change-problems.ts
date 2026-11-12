import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { changesDirOf, RecordId, type Api } from "@maycombhq/core";
import { changeFolder, changeStore } from "@maycombhq/changes";

/**
 * Beta.27 review: a change.yaml that doesn't read made its change vanish (GET /api/changes []
 * and every page of it 404) while Problems said nothing. The changes that don't read, with the
 * file and the line where YAML names one, and the words a page says for an id that isn't a change.
 */

const lineOf = (message: string): number | undefined => {
  const m = /\bat line (\d+)/.exec(message);
  return m ? Number(m[1]) : undefined;
};

/** The changes whose change.yaml doesn't read, by id. */
export async function changeProblems(root: string): Promise<Api.ChangeProblemsT> {
  const { problems } = await changeStore(root).listWithProblems();
  return problems.map((p) => {
    const file = relative(root, p.file).split(sep).join("/");
    const id = file.split("/").at(-2) ?? file;
    // The path is said once, as `file`: the message starts with it. YAML's excerpt of the lines
    // round the error goes: its first line says what and where.
    const message = (
      p.message.startsWith(`${p.file}: `) ? p.message.slice(p.file.length + 2) : p.message
    )
      .split("\n")[0]!
      .replace(/:\s*$/, "")
      .trim();
    const line = lineOf(message);
    return { id, file, ...(line ? { line } : {}), message };
  });
}

/** Edit distance, for the ids nearest one that isn't a change. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}

/** Up to three change ids near `id`: one containing the other, or a few letters apart. */
export function nearIds(id: string, ids: readonly string[]): string[] {
  const want = id.toLowerCase().slice(0, 120);
  return ids
    .map((x) => ({
      x,
      d: x.includes(want) || want.includes(x) ? 0 : distance(want, x),
    }))
    .filter((c) => c.x !== id && c.d <= Math.max(2, Math.floor(want.length / 3)))
    .sort((a, b) => a.d - b.d || a.x.localeCompare(b.x))
    .slice(0, 3)
    .map((c) => c.x);
}

/**
 * Why `id` can't be shown: its change.yaml doesn't read (the file, the line, why), or there is no
 * such change, with the nearest ids there are.
 */
export async function missingChangeWords(root: string, id: string): Promise<string> {
  if (RecordId.safeParse(id).success) {
    const broken = (await changeProblems(root).catch(() => [])).find((p) => p.id === id);
    if (broken)
      return `${id}'s change.yaml doesn't read (${broken.file}${broken.line ? `, line ${broken.line}` : ""}): ${broken.message.replace(/[^.!?]$/, "$&.")} Fix the file and the change comes back.`;
  }
  const ids = await readdir(changesDirOf(root), { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory() && e.name !== "archive").map((e) => e.name))
    .catch(() => [] as string[]);
  const real: string[] = [];
  for (const x of ids)
    if (await stat(join(changeFolder(root, x), "change.yaml")).catch(() => undefined)) real.push(x);
  const near = nearIds(id, real);
  return `There is no change ${id}.${near.length ? ` Did you mean ${near.join(", ")}?` : ""}`;
}
