import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { catalogDirOf, cmpText, factsDirOf, parseFacts, type CatalogRecord } from "@maycombhq/core";
import {
  buildAndWrite,
  factsSnapshotWrites,
  planUpgradeToSlots,
  readersSlotPath,
  serializeReadersSlot,
  SLOT_VERSION,
  type BuildAndWrite,
} from "@maycombhq/scanner";
import { verifyCommand } from "../src/verify-commands.js";

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

/**
 * `verifyCommand` as a person runs it under ADR 0195 (CS2): with `--write`, a build that lists
 * removals above the limit (the facts' read replacing the readers', an answer joining a loose
 * end) is confirmed with exactly the count it listed. Tests written before the guards import
 * this in its place, so they keep testing what they were about.
 */
export const verifyConfirmed: typeof verifyCommand = (root, repo, o, out) =>
  o.write
    ? confirmed(
        (x, allowRemovals) =>
          verifyCommand(
            root,
            repo,
            { ...o, ...(allowRemovals !== undefined ? { allowRemovals } : {}) },
            x,
          ),
        out,
      )
    : verifyCommand(root, repo, o, out);

/**
 * The other repos' facts files of a fixture as their facts snapshots, as a successful
 * `atticus verify <repo> --write` of each would have taken them (ADR 0195, CS2): the build's
 * estate join reads snapshots only, never the assistant's working files. Synchronous, so a
 * fixture's metarepo() can call it; a file not all verified is left out, as verify would refuse it.
 */
export function snapshotFactsFiles(root: string, except: readonly string[] = []): void {
  const dir = factsDirOf(root);
  for (const n of (existsSync(dir) ? readdirSync(dir) : []).sort()) {
    const m = /^([^.]+(?:\.[^.]+)*?)\.jsonl$/.exec(n);
    if (!m || /\.(rejected|corrections|reviewed)\.jsonl$/.test(n)) continue;
    const repo = m[1]!;
    if (except.includes(repo)) continue;
    const p = parseFacts(readFileSync(join(dir, n), "utf8"));
    if (!p.ok || !p.facts.length || p.facts.some((f) => f.verified === "none")) continue;
    const commits = [...new Set(p.facts.map((f) => f.commit))];
    for (const w of factsSnapshotWrites(root, repo, p.facts, {
      commit: commits.length === 1 ? commits[0]! : "unknown",
      contracts: null,
    })) {
      mkdirSync(dirname(w.path), { recursive: true });
      writeFileSync(w.path, w.text!);
    }
  }
}

/**
 * A test's hand-seeded catalog/generated adopted (ADR 0195 point 6): every record into legacy
 * slots, as `atticus upgrade --yes` adopts a catalog from before the slots, then one build. A
 * hand-seeded catalog lacks what the build's passes add (features, glossary terms, intake's
 * documents), which the upgrade itself would refuse; a test's seed takes them. Tests that
 * seeded the catalog itself and then run a writer call this after seeding (CS5 moves them onto
 * readers slots).
 */
export async function adoptSeeded(root: string): Promise<void> {
  const plan = await planUpgradeToSlots(root);
  if (!plan.pending) return;
  for (const w of plan.writes) {
    if (w.path.endsWith("build.json") || w.path.includes("generated-before-upgrade")) continue;
    await mkdir(dirname(w.path), { recursive: true });
    await writeFile(w.path, w.text);
  }
  await rm(join(catalogDirOf(root), "generated"), { recursive: true, force: true });
  const r = await buildAndWrite(root, { command: "seed" });
  if (r.guard.refused) throw new Error(`seed refused: ${r.guard.refused.message}`);
}
