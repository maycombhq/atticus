import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_IGNORES } from "@maycombhq/sdk";

/** G4: a checkout's files, relative with `/`, the usual folders left out (for `atticus rules try`). */
export async function listFiles(dir: string, max = 50_000): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(DEFAULT_IGNORES.map((x) => x.replace(/\/\*\*$/, "").replace(/^\*\*\//, "")));
  const walk = async (d: string, rel: string): Promise<void> => {
    if (out.length >= max) return;
    const items = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  await walk(dir, "");
  return out;
}
