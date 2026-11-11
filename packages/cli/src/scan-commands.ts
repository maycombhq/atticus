import { join } from "node:path";
import { acquireLock, catalogDirOf, LockHeldError, type CatalogRecord } from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";
import { driftAfterScan, type DriftAfterScan } from "@maycombhq/speckit";
import {
  diffCatalogs,
  diffIsEmpty,
  readCatalog,
  scanEstate,
  writeCatalog,
  type CatalogDiff,
  type EstateScan,
  type UnreadRepo,
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

/**
 * Why a scan wrote nothing (beta.26 safety stop): each production repo it didn't read in full,
 * with what to do, and, when it read them all, that it found no records where the catalog has
 * some (as Backstage's rejectEmptySourceCollections). `--json` prints it under `refused`.
 */
export interface ScanRefusal {
  repos: { repo: string; why: UnreadRepo["why"]; message: string; runs?: UnreadRepo["runs"] }[];
  /** The scan read every repo and found nothing, while catalog/generated has this many records. */
  empty?: { before: number };
  /** The whole refusal in words, what to do included. */
  message: string;
}

const FACTS_PATH =
  "Scan every repo (atticus scan, after atticus workspace sync), or put one repo's read in the catalog from its facts: atticus verify <repo> --write.";

/** What a person reads for one repo not read in full. */
function unreadMessage(u: UnreadRepo): string {
  switch (u.why) {
    case "not-cloned":
      return "not cloned here; clone it with atticus workspace sync";
    case "unreadable":
      return `its clone can't be read (${u.detail ?? "git couldn't read it"}); clone it again with atticus workspace sync`;
    case "run-failed":
      return `${(u.runs ?? [])
        .map((r) => `the run of ${r.extractor} failed (${r.error})`)
        .join("; ")}, so its read is short of what that run reads; fix it, then scan again`;
    case "not-asked":
      return "left out by --repos";
  }
}

/** A record read from a repo's code (its evidence names the repo), not from a profile or inputs/. */
const fromCode = (r: CatalogRecord) => r.evidence.some((e) => !!e.repo);

/**
 * Whether a scan may replace catalog/generated: undefined when it may, else why not. It may only
 * when every production repo (archived repos and prototypes aren't) was read in full, and when it
 * found something in the repos' code or the catalog holds nothing from code (a scan that read no
 * code would take every repo's records out; the profiles' systems alone don't count).
 */
export function scanRefusal(
  scan: Pick<EstateScan, "unread" | "records">,
  before: readonly CatalogRecord[],
): ScanRefusal | undefined {
  const unread = scan.unread;
  if (unread.length) {
    const asked = unread.filter((u) => u.why === "not-asked");
    const lines = unread
      .filter((u) => u.why !== "not-asked")
      .map((u) => `${u.repo}: ${unreadMessage(u)}`);
    if (asked.length)
      lines.push(
        `${asked.map((u) => u.repo).join(", ")}: left out by --repos; a scan of only some repos would replace the catalog with them alone, so it isn't written`,
      );
    return {
      repos: unread.map((u) => ({
        repo: u.repo,
        why: u.why,
        message: unreadMessage(u),
        ...(u.runs ? { runs: u.runs } : {}),
      })),
      message: [
        `Nothing written: catalog/generated is as it was. A scan replaces the whole catalog, so it writes only when it has read every repo in full, and it didn't read ${unread.length === 1 ? "this one" : `these ${unread.length}`}:`,
        ...lines.map((l) => `  ${l}`),
        FACTS_PATH,
      ].join("\n"),
    };
  }
  const had = before.filter(fromCode).length;
  if (had > 0 && !scan.records.some(fromCode))
    return {
      repos: [],
      empty: { before: had },
      message: `Nothing written: the scan found no records in any repo's code, and catalog/generated has ${had}, so it is left as it was. Check that the manifests list the repos to read (an archived repo or a prototype isn't read), then scan again.`,
    };
  return undefined;
}

/**
 * A problem the refusal already says (a repo not cloned or unreadable, a failed run), so a
 * person reads each once; `--json` keeps every problem.
 */
function saidByRefusal(
  p: { repo?: unknown; source?: unknown },
  refused: Pick<ScanRefusal, "repos"> | undefined,
): boolean {
  const r = refused?.repos.find((x) => x.repo === p.repo);
  if (!r) return false;
  return (
    p.source === "workspace" || (r.runs ?? []).some((x) => x.extractor === String(p.source ?? ""))
  );
}

/**
 * A scan's `--json` report said in words, for the app's Console (beta.26): what it read and
 * wrote, or why it wrote nothing, its notes and problems; never the JSON itself.
 */
export function scanSummaryLines(report: Record<string, unknown>): string[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const n = (x: number, one: string) => `${x} ${one}${x === 1 ? "" : "s"}`;
  const refusal = report.refused as ScanRefusal | undefined;
  const problemLines = () =>
    (Array.isArray(report.problems) ? report.problems : [])
      .filter((p) => !saidByRefusal((p ?? {}) as { repo?: unknown }, refusal))
      .map((p) => {
        const x = (p ?? {}) as { repo?: unknown; source?: unknown; message?: unknown };
        return `${x.repo ? `${String(x.repo)}: ` : ""}${x.source ? `${String(x.source)}: ` : ""}${String(x.message ?? "")}`;
      });
  // A branch scanned beside the baseline (ADR 0123) reports its branch, repos and folder.
  if (typeof report.branch === "string") {
    const repos = (Array.isArray(report.repos) ? report.repos : []).map((r) =>
      String((r as { id?: unknown }).id ?? ""),
    );
    const d = report.diff as CatalogDiff | undefined;
    return [
      `Scanned ${report.branch} of ${repos.join(", ")} into ${String(report.folder ?? "")}/generated.`,
      ...(d ? [`${report.branch} against the baseline: ${diffLines(d)[0]}`] : []),
      ...problemLines(),
    ];
  }
  if (!report.stats) return [];
  const s = report.stats as Record<string, unknown>;
  const out = [
    `Scanned ${n(num(s.repos), "repo")}: ${n(num(s.records), "record")}, ${n(num(s.interfaces), "interface")} (${num(s.verified)} verified), ${n(num(s.unresolved), "loose end")}.`,
  ];
  const f = report.files as { written?: unknown; unchanged?: unknown; removed?: unknown } | null;
  if (f)
    out.push(
      `catalog/generated: ${num(f.written)} written, ${num(f.unchanged)} unchanged, ${num(f.removed)} removed`,
    );
  for (const note of Array.isArray(report.notes) ? report.notes : [])
    out.push(`note: ${String(note)}`);
  out.push(...problemLines());
  const w = Array.isArray(report.warnings) ? report.warnings.length : 0;
  if (w) out.push(`${n(w, "warning")}: atticus scan --warnings lists ${w === 1 ? "it" : "them"}`);
  if (typeof refusal?.message === "string") out.push(...refusal.message.split("\n"));
  return out;
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

/**
 * atticus scan: scan every repo's base clone, merge, and write catalog/generated, only when
 * every production repo was read in full (`scanRefusal`; beta.26). Exit 0 ok, 1 when any repo,
 * extractor, dialect or record had a problem or nothing was written for that, 2 for usage.
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
  const scan = await scanEstate({
    root,
    ...(o.repos ? { repos: o.repos } : {}),
    ...(o.full ? { cache: null } : {}),
  });
  // Beta.26 safety stop: a scan that didn't read every repo in full writes nothing (nor runs
  // the drift check or asks about hosts, which read what it would have written).
  const refused = scanRefusal(scan, before.records);
  const diff = refused
    ? { added: [], removed: [], changed: [], evidenceOnly: [] }
    : diffCatalogs(before.records, scan.records);
  const write = o.dryRun || refused ? undefined : await writeCatalog(out, scan.records);
  // The drift check reads the catalog just written, so it runs only when one was.
  const drift = write && !o.noDrift ? await driftAfterScan(root) : [];
  // Calls to a host no repo lists join nothing: ask which repo answers on it (ADR 0088).
  const hosts = write
    ? await askHosts(root, scan.records, {
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
          ...(refused ? { refused } : {}),
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
    if (!refused) for (const l of diffLines(diff)) io.out(l);
    if (write)
      io.out(
        `catalog/generated: ${write.written} written, ${write.unchanged} unchanged, ${write.removed} removed`,
      );
    else if (!refused) io.out("Dry run: nothing written.");
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
    for (const p of problems.filter((x) => !saidByRefusal(x, refused)))
      io.err(`${"repo" in p && p.repo ? `${p.repo}: ` : ""}${p.source}: ${p.message}`);
    if (refused) for (const l of refused.message.split("\n")) io.err(l);
  }
  return problems.length > 0 || refused ? 1 : 0;
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
