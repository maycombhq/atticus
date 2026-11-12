import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cmpText, type CatalogRecord } from "@maycombhq/core";
import {
  buildAndWrite,
  readersSlotPath,
  serializeReadersSlot,
  SLOT_VERSION,
  type BuildAndWrite,
} from "@maycombhq/scanner";

/**
 * A metarepo's catalog seeded the way ADR 0195 builds it (CS2; CS5 moves the rest of the tests
 * onto it): each repo's readers' records as its readers slot, at a commit, then one build, so
 * `catalog/generated` and `build.json` agree. A test that runs a writer seeds this way, never by
 * writing `catalog/generated` itself (a catalog no build wrote is one to upgrade first).
 */
export async function seedReadersSlots(
  root: string,
  records: readonly CatalogRecord[],
  o: { commit?: string } = {},
): Promise<BuildAndWrite> {
  const byRepo = new Map<string, CatalogRecord[]>();
  for (const r of records) {
    const repos = [...new Set(r.evidence.flatMap((e) => (e.repo ? [e.repo] : [])))];
    if (repos.length !== 1) continue;
    byRepo.set(repos[0]!, [...(byRepo.get(repos[0]!) ?? []), r]);
  }
  for (const [repo, rs] of [...byRepo].sort((a, b) => cmpText(a[0], b[0]))) {
    const path = readersSlotPath(root, repo);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      serializeReadersSlot({
        slotVersion: SLOT_VERSION,
        kind: "readers",
        repo,
        commit: o.commit ?? "a".repeat(40),
        status: "read",
        extractors: [],
        settings: "0".repeat(64),
        records: rs,
      }),
    );
  }
  const r = await buildAndWrite(root, { command: "seed" });
  if (r.guard.refused) throw new Error(`seed refused: ${r.guard.refused.message}`);
  return r;
}

type Io = { out: (l: string) => void; err: (l: string) => void };

/**
 * A writer run as a person runs it once a build lists its removals (ADR 0195 point 4): run, and
 * when a guard refused it only for large removals, confirm exactly the count it listed. Nothing
 * of the refused run reaches `io`; anything else is passed on as it was said.
 */
export async function confirmed(
  run: (io: Io, allowRemovals?: number) => Promise<number>,
  io: Io,
): Promise<number> {
  const lines: [boolean, string][] = [];
  const code = await run({ out: (l) => lines.push([true, l]), err: (l) => lines.push([false, l]) });
  const said = lines.map(([, l]) => l).join("\n");
  const n = /--allow-removals (\d+)\./.exec(said)?.[1];
  if (code !== 0 && n && /waits? for you to confirm/.test(said) && !said.includes("by hand"))
    return run(io, Number(n));
  for (const [out, l] of lines) (out ? io.out : io.err)(l);
  return code;
}
