import { join } from "node:path";
import { acquireLock, catalogDirOf, LockHeldError } from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";
import { driftAfterScan, type DriftAfterScan } from "@maycombhq/speckit";
import {
  diffCatalogs,
  diffIsEmpty,
  readCatalog,
  scanEstate,
  writeCatalog,
  type CarriedSummary,
  type CatalogDiff,
  type UnreadWhy,
} from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { askHosts } from "./host-questions.js";

/** The lines a person reads for a catalog diff: + added, - removed, ~ changed (fields). */
export function diffLines(d: CatalogDiff): string[] {
  if (diffIsEmpty(d)) return ["No catalog changes."];
  const lines = [
    `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.evidenceOnly.length} with new evidence only`,
    ...d.added.map((r) => `+ ${r.kind}/${r.id}`),
    ...d.removed.map((r) => `- ${r.kind}/${r.id}`),
    ...d.changed.map((r) => `~ ${r.kind}/${r.id} (${r.fields.join(", ")})`),
  ];
  return lines;
}

export interface ScanCommandOptions {
  repos?: string[];
  full?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Skip the drift check for open changes in build or qa that runs after the catalog is written. */
  noDrift?: boolean;
  /** List every warning (files left out, rules that couldn't fill a template), not just the count. */
  warnings?: boolean;
  /** Another branch, scanned beside the baseline into catalog/branches/<branch>/ (ADR 0123). */
  ref?: string;
  /**
   * App-only audit: ask which repo answers on an unknown host only for calls from these repos
   * (the app passes the repos the assistant has read); every repo when left out.
   */
  askFrom?: ReadonlySet<string>;
}

function driftLine(d: DriftAfterScan): string {
  const head = `Drift check for ${d.change} (${d.state})`;
  if (d.error) return `${head} couldn't run: ${d.error}`;
  if (d.round === undefined) return `${head}: no drift.`;
  const what = `${d.open} open finding${d.open === 1 ? "" : "s"}${d.blocking ? ` (${d.blocking} blocking)` : ""}`;
  return `${head}: ${what} in review/drift/${d.round}${d.unchanged ? ", nothing new" : ""}.`;
}

/** What a scan carried that it couldn't read (scanner's scan-carry.ts), said before what changed. */
export function keptLines(k: CarriedSummary): string[] {
  const out: string[] = [];
  const n = (x: number, one: string) => `${x} ${one}${x === 1 ? "" : "s"}`;
  // Beta.26 review: said by why each repo wasn't read; only a repo not cloned is told to clone.
  for (const g of k.by) {
    const one = g.repos.length === 1;
    const head = `Kept ${n(g.records, "record")} as ${g.records === 1 ? "it was" : "they were"} of ${g.repos.join(", ")}`;
    if (g.why === "not-cloned")
      out.push(
        `${head}, ${one ? "which isn't" : "which aren't"} cloned here: atticus workspace sync clones ${one ? "it" : "them"}, then scan again to read ${one ? "it" : "them"}.`,
      );
    else if (g.why === "unreadable")
      out.push(
        `${head}, whose clone${one ? "" : "s"} couldn't be read (see the problems below): atticus workspace sync, then scan again.`,
      );
    else
      out.push(
        `${head}, which this scan wasn't asked to read (--repos): a scan without --repos reads ${one ? "it" : "them"} again.`,
      );
  }
  if (k.fromFacts)
    out.push(
      `Kept ${n(k.fromFacts, "record")} from your assistant's verified facts while the readers stand in: the readers' records are beside them, never over them, until atticus verify <repo> --write.`,
    );
  if (k.covered)
    out.push(
      `Left out ${n(k.covered, "record")} of the readers' that a kept fact record already has (the same call, endpoint, table, column or setting).`,
    );
  if (k.outdated)
    out.push(
      `Let go ${n(k.outdated, "record")} from your assistant's facts that cite a file changed since they were read: /atticus-map <repo>, then atticus verify <repo> --write reads ${k.outdated === 1 ? "it" : "them"} again.`,
    );
  return out;
}

/**
 * Beta.26 review: a scan's `--json` report said in words, for the app's Console (the job keeps
 * the JSON as its result): what it read, what it kept, what it wrote, its problems and notes.
 */
export function scanSummaryLines(report: Record<string, unknown>): string[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const n = (x: number, one: string) => `${x} ${one}${x === 1 ? "" : "s"}`;
  const s = (report.stats ?? {}) as Record<string, unknown>;
  const out = [
    `Scanned ${n(num(s.repos), "repo")}: ${n(num(s.records), "record")}, ${n(num(s.interfaces), "interface")} (${num(s.verified)} verified), ${n(num(s.unresolved), "loose end")}.`,
  ];
  const k = (report.kept ?? {}) as Record<string, unknown>;
  const why = (v: unknown): UnreadWhy =>
    v === "unreadable" || v === "not-asked" ? v : "not-cloned";
  out.push(
    ...keptLines({
      unread: Array.isArray(k.unread) ? k.unread.map(String) : [],
      records: num(k.records),
      by: (Array.isArray(k.by) ? k.by : []).map((g) => {
        const x = (g ?? {}) as Record<string, unknown>;
        return {
          why: why(x.why),
          repos: Array.isArray(x.repos) ? x.repos.map(String) : [],
          records: num(x.records),
        };
      }),
      fromFacts: num(k.fromFacts),
      covered: num(k.covered),
      outdated: num(k.outdated),
    }),
  );
  const f = report.files as { written?: unknown; unchanged?: unknown; removed?: unknown } | null;
  if (f)
    out.push(
      `catalog/generated: ${num(f.written)} written, ${num(f.unchanged)} unchanged, ${num(f.removed)} removed`,
    );
  for (const note of Array.isArray(report.notes) ? report.notes : [])
    out.push(`note: ${String(note)}`);
  for (const p of Array.isArray(report.problems) ? report.problems : []) {
    const x = (p ?? {}) as { repo?: unknown; source?: unknown; message?: unknown };
    out.push(
      `${x.repo ? `${String(x.repo)}: ` : ""}${String(x.source ?? "")}: ${String(x.message ?? "")}`,
    );
  }
  const w = Array.isArray(report.warnings) ? report.warnings.length : 0;
  if (w) out.push(`${n(w, "warning")}: atticus scan --warnings lists ${w === 1 ? "it" : "them"}`);
  return out;
}

/**
 * atticus scan: scan every repo's base clone, merge, and write catalog/generated.
 * Exit 0 ok, 1 when any repo, extractor, dialect or record had a problem, 2 for usage.
 */
export async function scanCommand(
  root: string,
  o: ScanCommandOptions,
  io: Output,
): Promise<number> {
  if (o.repos && o.repos.length > 0) {
    const known = new Set((await loadRepos(root)).map((r) => r.id));
    const unknown = o.repos.filter((r) => !known.has(r));
    if (unknown.length > 0) {
      io.err(`Not in any repos.manifest.yaml: ${unknown.join(", ")}`);
      return 2;
    }
  }
  // One scan at a time per metarepo; a scan whose process is gone was cut short.
  let lock: Awaited<ReturnType<typeof acquireLock>> | undefined;
  if (!o.dryRun) {
    try {
      lock = await acquireLock(root, "scan", "scan");
    } catch (e) {
      if (e instanceof LockHeldError) {
        io.err(e.message);
        return 1;
      }
      throw e;
    }
    if (lock.interrupted)
      io.err(
        `The last scan (started ${lock.interrupted.startedAt}) stopped before it finished; this one brings the catalog up to date.`,
      );
  }
  try {
    if (o.ref) {
      const { scanBranch } = await import("./branch-scan-commands.js");
      return await scanBranch(
        root,
        o.ref,
        {
          ...(o.repos ? { repos: o.repos } : {}),
          ...(o.full ? { full: true } : {}),
          ...(o.json ? { json: true } : {}),
        },
        io,
      );
    }
    return await scanLocked(root, o, io);
  } finally {
    await lock?.release();
  }
}

async function scanLocked(root: string, o: ScanCommandOptions, io: Output): Promise<number> {
  const out = join(catalogDirOf(root), "generated");
  const before = await readCatalog(out, { cacheRoot: root });
  const started = Date.now();
  // Beta.26 review: the readers are a cross-check, so what the scan can't read is carried from
  // the catalog before it and merged beside what it reads (scanner's scan-carry.ts, ADR 0124
  // addendum B-keep): the records of an estate repo not read here (not cloned, a clone that
  // doesn't read, not asked for), and those from verified facts while the readers stand in.
  const scan = await scanEstate({
    root,
    ...(o.repos ? { repos: o.repos } : {}),
    ...(o.full ? { cache: null } : {}),
    carry: before.records,
  });
  const kept: CarriedSummary = scan.carried ?? {
    unread: [],
    records: 0,
    by: [],
    fromFacts: 0,
    covered: 0,
    outdated: 0,
  };
  const records = scan.records;
  const diff = diffCatalogs(before.records, records);
  const write = o.dryRun ? undefined : await writeCatalog(out, records);
  // The drift check reads the catalog just written, so it runs only when one was.
  const drift = write && !o.noDrift ? await driftAfterScan(root) : [];
  // Calls to a host no repo lists join nothing: ask which repo answers on it (ADR 0088).
  const hosts = write
    ? await askHosts(root, records, {
        command: "atticus scan",
        ...(o.askFrom ? { only: o.askFrom } : {}),
      })
    : { raised: [], open: [], lines: [] };
  const problems = [
    ...before.problems.map((p) => ({ source: `catalog/generated/${p.file}`, message: p.message })),
    ...scan.problems,
  ];
  // Warnings don't fail the scan, but they are what it couldn't read: never dropped silently.
  // The same file left out by several extractors is one warning.
  const seen = new Set<string>();
  const warnings = scan.repos.flatMap((r) =>
    r.warnings
      .map((w) => ({ repo: r.repo, ...w }))
      .filter((w) => {
        const k = `${w.repo}\u0000${w.path ?? ""}\u0000${w.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
  );
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          stats: scan.stats,
          diff,
          problems,
          warnings,
          coverage: scan.coverage,
          unmodelled: scan.unmodelled,
          notes: scan.notes,
          written: write !== undefined,
          files: write ?? null,
          drift,
          questions: [...hosts.raised, ...hosts.open].map((q) => q.id),
          kept,
        },
        null,
        2,
      ),
    );
  } else {
    const s = scan.stats;
    io.out(
      `Scanned ${s.repos} repos in ${((Date.now() - started) / 1000).toFixed(1)}s (${s.ranRuns} extractor runs, ${s.cachedRuns} from cache)`,
    );
    io.out(
      `${s.records} records: ${s.interfaces} interfaces (${s.verified} verified), ${s.unresolved} loose ends`,
    );
    const joined = scan.coverage.reduce((n, c) => n + c.joined, 0);
    const found = joined + scan.coverage.reduce((n, c) => n + c.open, 0);
    const unread = scan.coverage.reduce((n, c) => n + c.unreadFiles, 0);
    io.out(
      `Joined ${joined} of ${found} calls, listeners and endpoints found (${found ? Math.round((joined / found) * 100) : 100}%)` +
        (unread
          ? `; ${unread} file${unread === 1 ? " uses" : "s use"} a client library with nothing read (atticus scan --warnings)`
          : ""),
    );
    for (const c of scan.coverage)
      for (const r of c.redraft)
        io.out(
          `Rule ${r.dialect} on ${c.repo} ${r.why === "tests-fail" ? "fails its own tests, so this scan didn't use it" : "read nothing there"}; have your assistant re-draft it: atticus onboard ${c.repo} --name ${r.dialect} (then onboard accept ${r.dialect} --replace)`,
        );
    const toOnboard = scan.coverage.filter((c) => c.needsOnboarding);
    if (toOnboard.length)
      io.out(
        `Read nothing from ${toOnboard.length === 1 ? "1 repo" : `${toOnboard.length} repos`} whose files no reader knows: ${toOnboard
          .map(
            (c) =>
              `${c.repo} (${c.unreadConfig.length} file${c.unreadConfig.length === 1 ? "" : "s"})`,
          )
          .join(", ")}. Have your assistant draft a dialect: atticus onboard ${toOnboard[0]!.repo}`,
      );
    // House frameworks with no model, and models that read nothing any more (ADR 0066).
    for (const f of scan.unmodelled)
      io.out(
        `House framework ${f.framework} is imported by ${f.repos.length} repos and no framework model covers it: ${f.repos.join(", ")}. Onboard it: atticus onboard framework ${f.name} --from <its source, JAR or package> --users ${f.repos.join(",")}`,
      );
    const idle = new Map<string, string[]>();
    for (const c of scan.coverage)
      for (const r of c.redraftFrameworks)
        idle.set(r.framework, [...(idle.get(r.framework) ?? []), c.repo]);
    for (const [framework, repos] of idle)
      io.out(
        `Framework model ${framework} read nothing in ${repos.join(", ")}, which import${repos.length === 1 ? "s" : ""} it; the framework may have changed. Have your assistant re-draft it: atticus onboard framework ${framework} --from <its source, JAR or package> --users ${repos.join(",")} (then onboard accept framework ${framework} --replace)`,
      );
    for (const l of keptLines(kept)) io.out(l);
    for (const l of diffLines(diff)) io.out(l);
    if (write)
      io.out(
        `catalog/generated: ${write.written} written, ${write.unchanged} unchanged, ${write.removed} removed`,
      );
    else io.out("Dry run: nothing written.");
    for (const d of drift) io.out(driftLine(d));
    for (const l of hosts.lines) io.out(l);
    for (const n of scan.notes) io.out(`note: ${n}`);
    if (o.warnings)
      for (const w of warnings)
        io.out(`warning: ${w.repo}: ${w.path ? `${w.path}: ` : ""}${w.message}`);
    else if (warnings.length)
      io.out(
        `${warnings.length} warning${warnings.length === 1 ? "" : "s"}: atticus scan --warnings lists ${warnings.length === 1 ? "it" : "them"}`,
      );
    for (const p of problems)
      io.err(`${"repo" in p && p.repo ? `${p.repo}: ` : ""}${p.source}: ${p.message}`);
  }
  return problems.length > 0 ? 1 : 0;
}

/** atticus catalog diff <a> <b>: exit 0 when the catalogs hold the same facts and evidence, 1 otherwise. */
export async function catalogDiff(
  a: string,
  b: string,
  json: boolean,
  io: Output,
): Promise<number> {
  const [x, y] = await Promise.all([readCatalog(a), readCatalog(b)]);
  for (const p of [...x.problems, ...y.problems]) io.err(`${p.file}: ${p.message}`);
  const d = diffCatalogs(x.records, y.records);
  if (json) io.out(JSON.stringify(d, null, 2));
  else for (const l of diffLines(d)) io.out(l);
  return diffIsEmpty(d) && x.problems.length + y.problems.length === 0 ? 0 : 1;
}
