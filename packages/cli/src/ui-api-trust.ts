import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  catalogDirOf,
  factsDirOf,
  factsFileOf,
  factsRelOf,
  headFromFiles,
  isAdopted,
  auditItemHolds,
  auditPrecision,
  listQuestions,
  parseAuditFile,
  parseFacts,
  type Api,
  type Fact,
  type CatalogRecord,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { frameworkFacts, frameworkGaps } from "@maycombhq/verify";
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
type Lists = NonNullable<Repo["lists"]>;

/**
 * The lines of `<repo>.rejected.jsonl` (`writeVerifyFiles`), each with what it is about: a
 * rejected fact's id, kind, file and line, or a refused question, reviewed entry or line.
 */
export function rejectedLines(text: string | undefined): Lists["rejected"] {
  const out: Lists["rejected"] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let l: { code?: unknown; message?: unknown; fact?: Record<string, unknown> };
    try {
      l = JSON.parse(raw) as typeof l;
    } catch {
      out.push({ code: "unreadable", message: raw.slice(0, 200) });
      continue;
    }
    const f = l.fact && typeof l.fact === "object" ? l.fact : undefined;
    const cite = f?.cite as { file?: unknown; line?: unknown } | undefined;
    out.push({
      ...(typeof f?.id === "string" ? { fact: f.id } : {}),
      ...(typeof f?.kind === "string" ? { kind: f.kind } : {}),
      ...(typeof cite?.file === "string" ? { file: cite.file } : {}),
      ...(typeof cite?.line === "number" && Number.isInteger(cite.line) ? { line: cite.line } : {}),
      code: typeof l.code === "string" ? l.code : "rejected",
      message: typeof l.message === "string" ? l.message : "",
    });
  }
  return out;
}

const SHA = /^[0-9a-f]{7,64}$/;
/**
 * A projected fact's evidence says whose fact it was (ADR 0124: an assistant's, a reader's or a
 * person's) and names no extractor; a built-in reader's evidence is the rest.
 */
const FACT_BY = new Set(["assistant", "reader", "person"]);
const UNKNOWN_SHOWN = 50;

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;
const text = (p: string) => readFile(p, "utf8").catch(() => undefined);

/** The commit a checkout is at, from its `.git` files (core, ADR 0140). */
export { headFromFiles };

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

/**
 * Per repo, how many records of the catalog cite it from its facts (an assistant's, a reader's or
 * a person's fact, no extractor) and how many only from the built-in readers. A person's own
 * statement (manual evidence) is neither.
 */
export function catalogSources(
  records: readonly CatalogRecord[],
): Map<string, { facts: number; readers: number }> {
  const counts = new Map<string, { facts: number; readers: number }>();
  for (const r of records) {
    const seen = new Map<string, { facts: boolean; readers: boolean }>();
    for (const e of r.evidence) {
      if (!e.repo) continue;
      const s = seen.get(e.repo) ?? { facts: false, readers: false };
      if (!e.extractor && e.by && FACT_BY.has(e.by)) s.facts = true;
      else if (e.source !== "manual") s.readers = true;
      seen.set(e.repo, s);
    }
    for (const [repo, s] of seen) {
      const c = counts.get(repo) ?? { facts: 0, readers: 0 };
      if (s.facts) c.facts += 1;
      else if (s.readers) c.readers += 1;
      counts.set(repo, c);
    }
  }
  return counts;
}

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
  // A repo is named by its facts file or the verifier's report; the questions, rejected, reviewed
  // and corrections files beside them are companions, never a repo of their own.
  const files = await readdir(dir).catch(() => [] as string[]);
  const named = new Set<string>();
  for (const f of files) {
    const of = factsFileOf(f);
    if (of && (of.facts || f.endsWith(".verify.yaml"))) named.add(of.repo);
  }
  for (const id of [...named].sort()) if (!ids.includes(id)) ids.push(id);

  // What the catalog holds of each repo: records from its facts, records from the readers.
  const catalog = await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root });
  for (const p of catalog.problems)
    problems.push({ file: rel(join(catalogDirOf(root), "generated", p.file)), message: p.message });
  const counts = catalogSources(catalog.records);

  // ADR 0135: the open questions, by repo, so the asked count opens them.
  const open = await listQuestions(root, { state: "open" }).then(
    (l) => l.questions,
    () => [],
  );

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
    let frameworks: Repo["frameworks"];
    let terms: Repo["terms"];
    let kept: Fact[] = [];
    const lists: Lists = { rejected: [], excluded: [], asked: [], unverified: [] };
    if (raw !== undefined && raw.trim()) {
      const parsed = parseFacts(raw);
      if (parsed.ok) {
        kept = parsed.facts;
        facts.count = parsed.facts.length;
        const unchecked = parsed.facts.filter((f) => f.verified === "none");
        facts.unverified = unchecked.length;
        lists.unverified = unchecked.slice(0, UNKNOWN_SHOWN).map((f) => ({
          fact: f.id,
          kind: f.kind,
          file: f.cite.file,
          line: f.cite.line,
        }));
        const commit = parsed.facts[0]?.commit;
        if (commit) facts.commit = commit;
        // A-framework: what the repo is built on, and the frameworks whose patterns the facts
        // show none of. From the facts: no catalog record holds a framework.
        const gaps = new Map(frameworkGaps(parsed.facts).map((g) => [g.id, g.question] as const));
        const built = frameworkFacts(parsed.facts).map((f) => ({
          name: f.name,
          ...(f.version ? { version: f.version } : {}),
          ...(f.component ? { component: f.component } : {}),
          cite: `${f.cite.file}:${f.cite.line}`,
          ...(gaps.has(f.id) ? { gap: gaps.get(f.id)! } : {}),
        }));
        if (built.length) frameworks = built;
        // ADR 0163: the organisation's terms it writes, each with its role and lines.
        const t = parsed.facts.flatMap((f) =>
          f.kind === "term"
            ? [
                {
                  term: f.term,
                  value: f.value,
                  role: f.role,
                  cite: `${f.cite.file}:${f.cite.line}`,
                  ...(f.meaning ? { meaning: `${f.meaning.file}:${f.meaning.line}` } : {}),
                  ...(f.note !== undefined ? { note: f.note } : {}),
                },
              ]
            : [],
        );
        if (t.length) terms = t;
      } else
        problems.push({
          file: rel(factsPath),
          message: `doesn't read as facts: ${parsed.issues[0]?.message ?? "invalid"}`,
        });
    }

    const reportPath = join(dir, `${repo}.verify.yaml`);
    let report: Report | null = null;
    let excluded: string[] = [];
    const reportText = await text(reportPath);
    if (reportText !== undefined) {
      try {
        const doc = parse(reportText) as { coverage?: { excluded?: unknown } } | null;
        const r = reportOf(doc);
        if (typeof r === "string") problems.push({ file: rel(reportPath), message: r });
        else {
          report = r;
          const ex = doc?.coverage?.excluded;
          if (Array.isArray(ex)) excluded = ex.map(String).slice(0, UNKNOWN_SHOWN);
        }
      } catch (e) {
        problems.push({ file: rel(reportPath), message: `can't read YAML: ${firstLine(e)}` });
      }
    }
    if (!facts.commit && report?.commit) facts.commit = report.commit;
    lists.rejected = rejectedLines(await text(join(dir, `${repo}.rejected.jsonl`)));
    lists.excluded = excluded;
    lists.asked = open
      .filter((q) => q.repo === repo)
      .map((q) => ({ id: q.id, question: q.question, lines: q.evidence }));

    // ADR 0148 (P3): the sample audit's precision. A fact answer stands while the fact cites the
    // line the person saw; a link answer is counted as given (the join isn't run here).
    let audit: Repo["audit"];
    const auditPath = join(dir, `${repo}.audit.yaml`);
    const auditText = await text(auditPath);
    if (auditText !== undefined) {
      const a = parseAuditFile(auditText);
      if (!a.ok)
        problems.push({ file: rel(auditPath), message: `isn't an audit file: ${a.issues[0]}` });
      else {
        const byId = new Map(kept.map((f) => [f.id, f] as const));
        const p = auditPrecision(a.file.items, (i) => auditItemHolds(i, byId));
        audit = { path: rel(auditPath), facts: p.facts, byKind: p.byKind, links: p.links };
      }
    }

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
    repos.push({
      ...base,
      state,
      ...(next ? { next } : {}),
      ...(frameworks ? { frameworks } : {}),
      ...(terms ? { terms } : {}),
      lists,
      ...(audit ? { audit } : {}),
    });
  }
  return { factsDir: factsRel, repos, problems };
}

export function uiTrustRoutes(r: Router, ctx: ServerContext): Router {
  return (
    r
      .add("GET", "/api/trust", async () => ({ status: 200, body: await trustView(ctx.root) }))
      // ADR 0141 (P5): the estate's freshness. It runs read-only local git in the clones
      // (`git diff --name-status` between two commits they have); nothing fetched or written.
      .add("GET", "/api/trust/fresh", async () => {
        const { estateFreshness } = await import("./estate-fresh.js");
        const body: Api.FreshViewT = await estateFreshness(ctx.root);
        return { status: 200, body };
      })
  );
}
