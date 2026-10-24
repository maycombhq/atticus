import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  catalogDirOf,
  changesDirOf,
  readRepoSpec,
  RecordId,
  specRepos,
  specsDirOf,
  type Api,
} from "@maycombhq/core";
import { badRequest, type Router, type ServerContext } from "@maycombhq/server";
import { parse } from "yaml";
import type { Output } from "./commands.js";
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

/** States a change is no longer in flight in. */
const DONE = new Set(["released", "archived", "post-release-review"]);

/**
 * The changes in flight on each flow (WP7.3): those whose target-flows/ hold that flow, read
 * each time from the change folders (a handful of directory listings), by flow id.
 */
async function inFlight(root: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const dir = changesDirOf(root);
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name === "archive") continue;
    const yaml = await readFile(join(dir, e.name, "change.yaml"), "utf8").catch(() => "");
    const state = (() => {
      try {
        return (parse(yaml) as { state?: unknown } | null)?.state;
      } catch {
        return undefined;
      }
    })();
    if (!yaml || (typeof state === "string" && DONE.has(state))) continue;
    for (const f of await readdir(join(dir, e.name, "target-flows")).catch(() => [] as string[]))
      if (f.endsWith(".yaml")) {
        const flow = f.slice(0, -".yaml".length);
        out.set(flow, [...(out.get(flow) ?? []), e.name]);
      }
  }
  return out;
}

/** One file's cited lines, best first by line, each flow with the changes in flight on it. */
async function citeList(
  root: string,
  index: Index,
  repo: string,
  path: string,
): Promise<Api.CiteListT> {
  const lines = [...(index.get(repo)?.get(path)?.values() ?? [])].sort((a, b) => a.line - b.line);
  const flying = await inFlight(root);
  const shown = lines.map((l) => ({
    ...l,
    flows: [...l.flows]
      .sort((a, b) => a.flow.localeCompare(b.flow) || a.step - b.step)
      .map((f) => (flying.get(f.flow)?.length ? { ...f, changes: flying.get(f.flow)! } : f)),
  }));
  return { repo, path, lines: shown };
}

/**
 * Which repo a file on disk belongs to, from where it sits in the metarepo: workspace/<repo>/,
 * a change's worktree (workspace/.worktrees/<change>/<repo>/) or another branch's checkout
 * (workspace/.branches/<repo>/<branch>/). Anywhere else in the metarepo (an adopted repo's own
 * files) only the path is known; undefined outside the metarepo.
 */
export function fileInRepo(
  root: string,
  file: string,
): { repo?: string; path: string } | undefined {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const parts = rel.split(sep);
  if (parts[0] !== "workspace") return { path: parts.join("/") };
  const at = parts[1] === ".worktrees" ? 3 : parts[1] === ".branches" ? 2 : 1;
  const repo = parts[at];
  const rest = parts.slice(parts[1] === ".branches" ? 4 : at + 1);
  if (!repo || !rest.length || !RecordId.safeParse(repo).success) return undefined;
  return { repo, path: rest.join("/") };
}

/**
 * atticus cites (--repo r --path p | --file f) [--json]: what cites each line of one file, as
 * GET /api/cites gives it, for an editor that can't call the app (IntelliJ's gutter).
 */
export async function citesCli(
  root: string,
  o: { repo?: string; path?: string; file?: string; json?: boolean },
  io: Output,
): Promise<number> {
  let repo = o.repo;
  let path = o.path;
  const index = await build(root);
  if (o.file) {
    const at = fileInRepo(root, o.file);
    if (!at) {
      io.err(`${o.file} isn't in this metarepo or a repo's checkout in its workspace.`);
      return 1;
    }
    path = at.path;
    repo = at.repo ?? [...index.keys()].find((r) => index.get(r)!.has(at.path)) ?? undefined;
    if (!repo) {
      if (o.json) io.out(JSON.stringify({ repo: "", path, lines: [] }, null, 2));
      else io.out(`Nothing in the specs or the catalog cites ${path}.`);
      return 0;
    }
  }
  if (!repo || !path || !RecordId.safeParse(repo).success) {
    io.err(
      "Say which file: atticus cites --repo <repo> --path <its path in the repo>, or --file <path on disk>.",
    );
    return 2;
  }
  const v = await citeList(root, index, repo, path);
  if (o.json) {
    io.out(JSON.stringify(v, null, 2));
    return 0;
  }
  if (!v.lines.length) {
    io.out(`Nothing in the specs or the catalog cites ${repo}/${path}.`);
    return 0;
  }
  for (const l of v.lines) {
    const flows = l.flows.map(
      (f) =>
        `${f.name} (step ${f.step})${f.changes?.length ? `, changed by ${f.changes.join(", ")}` : ""}`,
    );
    const records = l.records.map((r) => `${r.kind} ${r.name ?? r.id}`);
    io.out(`Line ${l.line}: ${[...flows, ...records].join("; ")}`);
  }
  return 0;
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
    return { status: 200, body: await citeList(root, await indexNow(), repo, path) };
  });
  return r;
}
