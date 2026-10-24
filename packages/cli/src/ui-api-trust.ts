import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  catalogDirOf,
  factsDirOf,
  factsRelOf,
  isAdopted,
  parseFacts,
  type Api,
  type CatalogRecord,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import type { Router, ServerContext } from "@maycombhq/server";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";

/**
 * GET /api/trust (ADR 0124 addendum, C4 2.22.0): how far to trust each repo's map, for the Map's
 * Trust tab. It reads files only: the manifests, `facts/<repo>.jsonl`, the verifier's
 * `<repo>.verify.yaml`, the checkout's HEAD from its `.git` files (no git runs), and
 * catalog/generated. It runs nothing and calls nothing.
 */

type View = Api.TrustViewT;
type Repo = View["repos"][number];
type Report = NonNullable<Repo["verify"]["report"]>;

const SHA = /^[0-9a-f]{7,64}$/;
const FULL_SHA = /^[0-9a-f]{40,64}$/;
/**
 * A projected fact's evidence says whose fact it was (ADR 0124: an assistant's, a reader's or a
 * person's) and names no extractor; a built-in reader's evidence is the rest.
 */
const FACT_BY = new Set(["assistant", "reader", "person"]);
const UNKNOWN_SHOWN = 50;

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;
const text = (p: string) => readFile(p, "utf8").catch(() => undefined);

/**
 * The commit a checkout is at, read from its `.git` files: HEAD, a loose ref or packed-refs,
 * following a worktree's `gitdir:` and `commondir`. Undefined when there is no checkout.
 */
export async function headFromFiles(dir: string): Promise<string | undefined> {
  let git = join(dir, ".git");
  const st = await stat(git).catch(() => undefined);
  if (!st) return undefined;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec((await text(git)) ?? "");
    if (!m) return undefined;
    git = resolve(dir, m[1]!.trim());
  }
  const common = (await text(join(git, "commondir")))?.trim();
  const commonDir = common ? resolve(git, common) : git;
  const head = ((await text(join(git, "HEAD"))) ?? "").trim();
  if (FULL_SHA.test(head)) return head;
  const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").includes("..")) return undefined;
  for (const d of [git, commonDir]) {
    const loose = ((await text(join(d, ...ref.split("/")))) ?? "").trim();
    if (FULL_SHA.test(loose)) return loose;
  }
  for (const line of ((await text(join(commonDir, "packed-refs"))) ?? "").split(/\r?\n/)) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha && FULL_SHA.test(sha)) return sha;
  }
  return undefined;
}

/** The verifier's report (`<repo>.verify.yaml`, `writeVerifyFiles`), or why it can't be read. */
function reportOf(raw: unknown): Report | string {
  const r = raw as {
    accepted?: unknown;
    rejected?: unknown;
    redacted?: unknown;
    commit?: unknown;
    coverage?: { ratio?: unknown; read?: unknown; unknown?: unknown; excluded?: unknown };
  } | null;
  if (!r || typeof r.accepted !== "number" || typeof r.rejected !== "number")
    return "not a verifier's report: accepted and rejected are missing";
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const unknown = list(r.coverage?.unknown);
  return {
    accepted: r.accepted,
    rejected: r.rejected,
    redacted: typeof r.redacted === "number" ? r.redacted : 0,
    coverage: {
      ratio: typeof r.coverage?.ratio === "number" ? r.coverage.ratio : 0,
      read: typeof r.coverage?.read === "number" ? r.coverage.read : 0,
      unknown: unknown.length,
      excluded: list(r.coverage?.excluded).length,
    },
    unknownFiles: unknown.slice(0, UNKNOWN_SHOWN),
    ...(typeof r.commit === "string" && SHA.test(r.commit) ? { commit: r.commit } : {}),
  };
}

/** Same commit when either names the other's prefix (facts may keep a short one). */
const sameCommit = (a: string | undefined, b: string | undefined): boolean | null =>
  a && b ? a.startsWith(b) || b.startsWith(a) : null;

/** What to do next for a repo, and the state that says why (the app says it in words). */
function nextOf(
  repo: string,
  r: Pick<Repo, "facts" | "verify" | "sameCommit" | "catalog">,
): { state: Repo["state"]; next?: Repo["next"] } {
  const read = { command: `atticus map ${repo}`, slash: `/atticus-map ${repo}` };
  if (!r.facts.present) return { state: "not-read", next: read };
  const report = r.verify.report;
  if (!report) return { state: "unverified", next: { command: `atticus verify ${repo}` } };
  if (report.rejected > 0)
    return {
      state: "rejected",
      next: { command: `atticus verify ${repo}`, slash: `/atticus-map ${repo}` },
    };
  if (r.sameCommit === false) return { state: "stale", next: read };
  if (r.facts.unverified > 0)
    return { state: "unverified", next: { command: `atticus verify ${repo}` } };
  if (r.catalog.fromFacts === 0)
    return { state: "unwritten", next: { command: `atticus verify ${repo} --write` } };
  if (report.coverage.unknown > 0) return { state: "unknown-files", next: read };
  return { state: "trusted" };
}

export async function trustView(root: string): Promise<View> {
  const rel = (p: string) => relative(root, p).split(sep).join("/") || ".";
  const problems: View["problems"] = [];
  const dir = factsDirOf(root);
  const factsRel = factsRelOf(root);

  // The repos: the manifests' in their order, then any the facts name that no manifest lists.
  const ids: string[] = [];
  try {
    for (const r of await loadRepos(root)) ids.push(r.id);
  } catch (e) {
    problems.push({ file: "org-pack/profiles", message: firstLine(e) });
  }
  const files = await readdir(dir).catch(() => [] as string[]);
  const named = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".rejected.jsonl")) continue;
    const m = /^(.+)\.(jsonl|verify\.yaml)$/.exec(f);
    if (m) named.add(m[1]!);
  }
  for (const id of [...named].sort()) if (!ids.includes(id)) ids.push(id);

  // What the catalog holds of each repo: records from its facts, records from the readers.
  const catalog = await readCatalog(join(catalogDirOf(root), "generated"));
  for (const p of catalog.problems)
    problems.push({ file: rel(join(catalogDirOf(root), "generated", p.file)), message: p.message });
  const counts = new Map<string, { facts: number; readers: number }>();
  const count = (r: CatalogRecord) => {
    const seen = new Map<string, { facts: boolean; readers: boolean }>();
    for (const e of r.evidence) {
      if (!e.repo) continue;
      const s = seen.get(e.repo) ?? { facts: false, readers: false };
      if (!e.extractor && e.by && FACT_BY.has(e.by)) s.facts = true;
      // A person's own statement (manual evidence) is neither; anything else a reader found.
      else if (e.source !== "manual") s.readers = true;
      seen.set(e.repo, s);
    }
    for (const [repo, s] of seen) {
      const c = counts.get(repo) ?? { facts: 0, readers: 0 };
      if (s.facts) c.facts += 1;
      else if (s.readers) c.readers += 1;
      counts.set(repo, c);
    }
  };
  for (const r of catalog.records) count(r);

  const adopted = isAdopted(root);
  const repos: Repo[] = [];
  for (const repo of ids) {
    const factsPath = join(dir, `${repo}.jsonl`);
    const raw = await text(factsPath);
    const facts: Repo["facts"] = {
      path: rel(factsPath),
      present: raw !== undefined,
      count: 0,
      unverified: 0,
    };
    if (raw !== undefined && raw.trim()) {
      const parsed = parseFacts(raw);
      if (parsed.ok) {
        facts.count = parsed.facts.length;
        facts.unverified = parsed.facts.filter((f) => f.verified === "none").length;
        const commit = parsed.facts[0]?.commit;
        if (commit) facts.commit = commit;
      } else
        problems.push({
          file: rel(factsPath),
          message: `doesn't read as facts: ${parsed.issues[0]?.message ?? "invalid"}`,
        });
    }

    const reportPath = join(dir, `${repo}.verify.yaml`);
    let report: Report | null = null;
    const reportText = await text(reportPath);
    if (reportText !== undefined) {
      try {
        const r = reportOf(parse(reportText));
        if (typeof r === "string") problems.push({ file: rel(reportPath), message: r });
        else report = r;
      } catch (e) {
        problems.push({ file: rel(reportPath), message: `can't read YAML: ${firstLine(e)}` });
      }
    }
    if (!facts.commit && report?.commit) facts.commit = report.commit;

    let checkoutDir: string | undefined;
    try {
      checkoutDir = adopted ? root : baseClonePath(root, repo);
    } catch {
      checkoutDir = undefined;
    }
    const head = checkoutDir ? await headFromFiles(checkoutDir) : undefined;
    const present = checkoutDir
      ? await stat(join(checkoutDir, ".git")).then(
          () => true,
          () => false,
        )
      : false;
    const checkout: Repo["checkout"] = {
      path: checkoutDir ? rel(checkoutDir) : `workspace/${repo}`,
      present,
      ...(head ? { commit: head } : {}),
    };

    const c = counts.get(repo) ?? { facts: 0, readers: 0 };
    const from: Repo["catalog"]["from"] =
      c.facts && c.readers ? "both" : c.facts ? "facts" : c.readers ? "readers" : "none";
    const base = {
      repo,
      facts,
      verify: { path: rel(reportPath), report },
      checkout,
      sameCommit: sameCommit(report?.commit ?? facts.commit, head),
      catalog: { from, fromFacts: c.facts, fromReaders: c.readers },
    };
    const { state, next } = nextOf(repo, base);
    repos.push({ ...base, state, ...(next ? { next } : {}) });
  }
  return { factsDir: factsRel, repos, problems };
}

export function uiTrustRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/trust", async () => ({ status: 200, body: await trustView(ctx.root) }));
}
