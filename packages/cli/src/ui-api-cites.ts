import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogDirOf,
  readRepoSpec,
  RecordId,
  specRepos,
  specsDirOf,
  type Api,
} from "@maycombhq/core";
import { badRequest, type Router, type ServerContext } from "@maycombhq/server";
import { catalogRecords } from "./site-commands.js";

/**
 * GET /api/cites (ADR 0094, C4): each line of one file that a spec flow or a catalog record cites,
 * for an editor's CodeLens. It reads files only: the spec folders and the catalog. The index of
 * every citation is built once and built again when a file under specs/ or the catalog changes
 * (their count or newest change time), so opening a file costs one lookup.
 */

type Line = Api.CiteListT["lines"][number];
type Index = Map<string, Map<string, Map<number, Line>>>;

/** How many files a folder holds and when the newest changed: cheap to read, changes on any edit. */
async function fingerprint(dirs: string[]): Promise<string> {
  let count = 0;
  let newest = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        count++;
        const s = await stat(p).catch(() => undefined);
        if (s && s.mtimeMs > newest) newest = s.mtimeMs;
      }
    }
  };
  for (const d of dirs) await walk(d);
  return `${count}:${newest}`;
}

async function build(root: string): Promise<Index> {
  const index: Index = new Map();
  const lineOf = (repo: string, path: string, line: number): Line => {
    const files = index.get(repo) ?? new Map<string, Map<number, Line>>();
    index.set(repo, files);
    const lines = files.get(path) ?? new Map<number, Line>();
    files.set(path, lines);
    const l = lines.get(line) ?? { line, flows: [], records: [] };
    lines.set(line, l);
    return l;
  };
  for (const specRepo of await specRepos(root))
    for (const f of (await readRepoSpec(root, specRepo)).flows) {
      const parts: {
        step: number;
        kind: string;
        confirmedBy?: string;
        evidence: (typeof f.steps)[number]["evidence"];
      }[] = [
        { step: 0, kind: f.trigger.kind, evidence: f.trigger.evidence },
        ...f.steps.map((s, i) => ({
          step: i + 1,
          kind: s.kind,
          ...(s.confirmedBy ? { confirmedBy: s.confirmedBy } : {}),
          evidence: s.evidence,
        })),
      ];
      for (const part of parts)
        for (const e of part.evidence) {
          if (!e.path || e.line === undefined) continue;
          const l = lineOf(e.repo ?? specRepo, e.path, e.line);
          if (l.flows.some((x) => x.flow === f.id && x.step === part.step)) continue;
          l.flows.push({
            repo: specRepo,
            flow: f.id,
            name: f.name,
            step: part.step,
            kind: part.kind,
            ...(part.confirmedBy ? { confirmedBy: part.confirmedBy } : {}),
          });
        }
    }
  for (const r of await catalogRecords(root)) {
    const name = (r as { name?: unknown }).name;
    for (const e of r.evidence) {
      if (!e.repo || !e.path || e.line === undefined) continue;
      const l = lineOf(e.repo, e.path, e.line);
      if (l.records.some((x) => x.kind === r.kind && x.id === r.id)) continue;
      l.records.push({
        kind: r.kind,
        id: r.id,
        ...(typeof name === "string" && name !== r.id ? { name } : {}),
        source: e.source,
      });
    }
  }
  return index;
}

export function uiCiteRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  let cached: { print: string; index: Promise<Index> } | undefined;
  const indexNow = async () => {
    const print = await fingerprint([specsDirOf(root), catalogDirOf(root)]);
    if (cached?.print !== print) cached = { print, index: build(root) };
    return cached.index;
  };

  // Built at start-up, so the first file an editor opens doesn't wait for it.
  void indexNow().catch(() => undefined);

  r.add("GET", "/api/cites", async ({ query }) => {
    const repo = query.get("repo");
    const path = query.get("path");
    if (!repo || !RecordId.safeParse(repo).success)
      throw badRequest("Say which repo: ?repo=<the repo's id>.");
    if (!path) throw badRequest("Say which file: ?path=<its path in the repo>.");
    const lines = [...((await indexNow()).get(repo)?.get(path)?.values() ?? [])].sort(
      (a, b) => a.line - b.line,
    );
    for (const l of lines) l.flows.sort((a, b) => a.flow.localeCompare(b.flow) || a.step - b.step);
    return { status: 200, body: { repo, path, lines } satisfies Api.CiteListT };
  });
  return r;
}
