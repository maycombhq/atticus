import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "./cli";
import {
  findFrom,
  latestSnapshot,
  scanReportFrom,
  snapshotCommit,
  type FindResult,
  type FindSummary,
  type KnowledgeEntry,
  type NeedEntry,
  type ScanReport,
} from "./knowledge-data";
import type { Cli } from "./types";
import { readYaml } from "./yaml-lite";

/**
 * What the knowledge section and a change's needs read (ADR 0101): the command line's JSON
 * (`knowledge list`, `needs`, `knowledge finds`) and the metarepo's own files (scan.yaml, the
 * snapshots, a saved search). Files only, read-only. No `vscode` here.
 */

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** The knowledge items, as people reviewed them; the command line's reason when there are none. */
export async function readKnowledgeList(
  cli: Cli,
  root: string,
): Promise<{ items: KnowledgeEntry[]; problem?: string }> {
  const r = await cli(["knowledge", "list", "--json", "--root", root]);
  const j = parseJson<KnowledgeEntry[]>(r.stdout);
  if (Array.isArray(j)) return { items: j };
  return {
    items: [],
    problem: firstLine(r.stderr) || firstLine(r.stdout) || "No knowledge items yet.",
  };
}

/** A change's needs, every one; undefined when it has no needs.yaml yet. */
export async function readNeeds(
  cli: Cli,
  root: string,
  change: string,
  changeDir: string,
): Promise<NeedEntry[] | undefined> {
  if (!existsSync(join(root, changeDir, "needs.yaml"))) return undefined;
  const r = await cli(["needs", "--change", change, "--all", "--json", "--root", root]);
  const j = parseJson<NeedEntry[]>(r.stdout);
  if (!Array.isArray(j))
    throw new Error(firstLine(r.stderr) || "Couldn't read the change's needs.");
  return j.map((n) => ({
    ...n,
    inputs: n.inputs ?? [],
    steps: n.steps ?? [],
    rules: n.rules ?? [],
  }));
}

/** What the last knowledge scan changed (knowledge/scan.yaml). */
export function readScanReport(root: string, knowledgeRel: string): ScanReport | undefined {
  try {
    return scanReportFrom(readYaml(readFileSync(join(root, knowledgeRel, "scan.yaml"), "utf8")));
  } catch {
    return undefined;
  }
}

/** Each source's newest snapshot, and the commit a git wiki's snapshot read. */
export function readSnapshots(
  root: string,
  knowledgeRel: string,
  sources: string[],
): Record<string, { date: string; commit?: string }> {
  const out: Record<string, { date: string; commit?: string }> = {};
  for (const id of sources)
    try {
      const dir = join(root, knowledgeRel, "snapshots", id);
      const date = latestSnapshot(readdirSync(dir));
      if (!date) continue;
      let commit: string | undefined;
      try {
        commit = snapshotCommit(readFileSync(join(dir, date, "snapshot.yaml"), "utf8"));
      } catch {
        // a snapshot without its manifest: the date is enough
      }
      out[id] = { date, ...(commit ? { commit } : {}) };
    } catch {
      // not synced yet
    }
  return out;
}

/** The saved searches of the wikis; none when the command line doesn't have them. */
export async function readFinds(cli: Cli, root: string): Promise<FindSummary[]> {
  const r = await cli(["knowledge", "finds", "--json", "--root", root]);
  const j = parseJson<unknown>(r.stdout);
  const list = Array.isArray(j) ? j : (j as { finds?: unknown } | undefined)?.finds;
  if (!Array.isArray(list)) return [];
  return list.flatMap((f: unknown) => {
    const x = f as Record<string, unknown>;
    if (typeof x?.slug !== "string") return [];
    const count = (v: unknown) => (Array.isArray(v) ? v.length : Number(v ?? 0) || 0);
    // Each search's candidates come with it, as candidateList.
    const list = Array.isArray(x.candidateList)
      ? findFrom({ candidates: x.candidateList })?.candidates
      : undefined;
    return [
      {
        slug: x.slug,
        phrase: typeof x.phrase === "string" ? x.phrase : x.slug,
        at: typeof x.at === "string" ? x.at : "",
        candidates: count(x.candidates),
        kept: count(x.kept),
        ...(list ? { list } : {}),
      },
    ];
  });
}

/** A saved search's candidates, from knowledge/finds/<slug>.yaml (or .json). */
export function readFind(root: string, knowledgeRel: string, slug: string): FindResult | undefined {
  const base = join(root, knowledgeRel, "finds", slug.replace(/[\\/]/g, ""));
  for (const [ext, parse] of [
    [".json", (t: string) => parseJson<unknown>(t)],
    [".yaml", readYaml],
    [".yml", readYaml],
  ] as const)
    try {
      const r = findFrom(parse(readFileSync(`${base}${ext}`, "utf8")));
      if (r) return r;
    } catch {
      // not this one
    }
  return undefined;
}
