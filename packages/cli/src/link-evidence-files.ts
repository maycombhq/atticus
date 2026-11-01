import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  ContractsFile,
  evidenceDirOf,
  evidenceRelOf,
  factsDirOf,
  factsRelOf,
  loadOrgPack,
  orgPackDirOf,
  readTrafficFile,
  trafficFileName,
  writeFileAtomic,
  type ContractsFileT,
  type Fact,
  type FactsJoinResult,
  type LinkEvidenceResult,
  type TrafficOnFile,
} from "@maycombhq/core";
import { TRAFFIC_SOURCES } from "@maycombhq/ingestors";
import { aggregateTraffic, readContractFiles } from "@maycombhq/intake";
import type { Output } from "./commands.js";

/**
 * ADR 0151 (J3, J4): the files that confirm links from outside the code. A repo's contract files
 * are read in its checkout at the facts' commit and kept beside its facts (`<repo>.contracts.yaml`),
 * so every write of any repo reads the same ones; the traffic aggregates people imported are in
 * `evidence/traffic/`, each reviewed in a pull request. Files only: nothing is fetched.
 */

/** How many findings a write prints (the rest are in the verify report). */
const SHOWN = 5;

/**
 * Read a repo's contract files in its checkout and keep them beside its facts; a repo with none
 * has no companion (an old one is removed). A contract file the metarepo's deny-list names a word
 * of is left out, and `onRefused` is told which.
 */
export async function writeRepoContracts(
  root: string,
  repo: string,
  dir: string,
  facts: readonly Fact[],
  onRefused?: (note: string) => void,
): Promise<ContractsFileT> {
  const commit = facts.map((f) => f.commit).sort()[0];
  const own = facts.flatMap((f) =>
    f.kind === "entry" && f.entryType === "rest"
      ? [{ ...(f.method ? { method: f.method } : {}), path: f.path }]
      : [],
  );
  const deny = await denyHashesAt(root);
  const file = await readContractFiles(dir, {
    repo,
    ...(commit ? { commit } : {}),
    own,
    ...(deny.size ? { denyHashes: deny } : {}),
    ...(onRefused ? { onRefused } : {}),
  });
  const path = join(factsDirOf(root), `${repo}.contracts.yaml`);
  if (file.entries.length) await writeFileAtomic(path, stringify(file, { lineWidth: 0 }));
  else await rm(path, { force: true });
  return file;
}

/** Every repo's contract companion and every traffic aggregate on file; a file that doesn't read is said. */
export async function loadLinkEvidence(
  root: string,
): Promise<{ contracts: ContractsFileT[]; traffic: TrafficOnFile[]; problems: string[] }> {
  const problems: string[] = [];
  const contracts: ContractsFileT[] = [];
  const fRel = factsRelOf(root);
  for (const n of (await readdir(factsDirOf(root)).catch(() => [] as string[])).sort()) {
    if (!n.endsWith(".contracts.yaml")) continue;
    let v: unknown;
    try {
      v = parse(await readFile(join(factsDirOf(root), n), "utf8"));
    } catch (e) {
      problems.push(`${fRel}/${n} isn't YAML (${(e as Error).message}); it is left out.`);
      continue;
    }
    const p = ContractsFile.safeParse(v);
    if (p.success) contracts.push(p.data);
    else problems.push(`${fRel}/${n} isn't a contracts file; it is left out.`);
  }
  const traffic: TrafficOnFile[] = [];
  const tDir = join(evidenceDirOf(root), "traffic");
  const tRel = `${evidenceRelOf(root)}/traffic`;
  for (const n of (await readdir(tDir).catch(() => [] as string[])).sort()) {
    if (!/\.ya?ml$/.test(n)) continue;
    const r = readTrafficFile(`${tRel}/${n}`, await readFile(join(tDir, n), "utf8"));
    if (r.ok) traffic.push(r.traffic);
    else problems.push(`${r.message}; it is left out.`);
  }
  return { contracts, traffic, problems };
}

/** The components a repo's write is about: its calls' and its entries' in the join, and the repo's own name. */
function componentsOf(repo: string, join: FactsJoinResult | undefined): Set<string> {
  const out = new Set([repo]);
  for (const j of join?.joins ?? []) {
    if (j.call.repo === repo) out.add(j.call.component);
    if (j.entry.repo === repo) out.add(j.entry.component);
  }
  return out;
}

/** The part of the evidence result about one repo, as its verify report holds it. */
export function linkEvidenceAbout(
  repo: string,
  le: LinkEvidenceResult,
  join: FactsJoinResult | undefined,
) {
  const comps = componentsOf(repo, join);
  const touches = (l: { from: string; to: string } | undefined) =>
    !!l && (comps.has(l.from) || comps.has(l.to));
  return {
    contracts: {
      confirmed: le.contracts.confirmed.filter(touches),
      findings: le.contracts.findings.filter((f) => f.repo === repo || f.links.some(touches)),
    },
    traffic: {
      seen: le.traffic.seen.filter(touches),
      findings: le.traffic.findings.filter(
        (f) => (f.component && comps.has(f.component)) || touches(f.link),
      ),
      // An app named like no component is the estate's, not one repo's: listed in every report.
      unknownApps: le.traffic.findings.filter((f) => f.reason === "unknown-app"),
    },
  };
}

/** What a write says of the contract files and traffic: counts, and the first few findings. */
export function linkEvidenceLines(
  about: ReturnType<typeof linkEvidenceAbout>,
  report: string,
  o: { verbose?: boolean } = {},
): string[] {
  const out: string[] = [];
  const show = (lines: string[]) => {
    const shown = o.verbose ? lines : lines.slice(0, SHOWN);
    out.push(...shown.map((l) => `    ${l}`));
    if (shown.length < lines.length)
      out.push(`    ... and ${lines.length - shown.length} more (in ${report})`);
  };
  const c = about.contracts;
  if (c.confirmed.length || c.findings.length) {
    out.push(
      `  Contracts: ${c.confirmed.length} link${c.confirmed.length === 1 ? "" : "s"} confirmed by a consumer's contract file, ${c.findings.length} request${c.findings.length === 1 ? "" : "s"} the join doesn't bear out (under contracts in ${report}):`,
    );
    show(c.findings.map((f) => `${f.reason}: ${f.message}`));
  }
  const t = about.traffic;
  const apps = t.unknownApps.length;
  if (t.seen.length || t.findings.length || apps) {
    out.push(
      `  Traffic: ${t.seen.length} link${t.seen.length === 1 ? "" : "s"} seen in imported traffic, ${t.findings.length} finding${t.findings.length === 1 ? "" : "s"}${apps ? `; ${apps} app${apps === 1 ? "" : "s"} in the estate's traffic named like no component (name each in its row)` : ""} (under traffic in ${report}):`,
    );
    show(t.findings.map((f) => `${f.reason}: ${f.message}`));
  }
  return out;
}

export interface IntakeTrafficOptions {
  source?: string;
  from?: string;
  to?: string;
  json?: boolean;
}

/**
 * atticus intake traffic <file> --source <source> [--from --to] (ADR 0151, J4): read a traffic
 * export (a file, never a live connection) into aggregate counts, check them, and write them to
 * `evidence/traffic/<source>-<from>-<to>.yaml` for a person to review in a pull request. Nothing
 * of a file that doesn't read into that shape, or whose aggregate fails a check, is written.
 */
export async function intakeTraffic(
  root: string,
  file: string,
  o: IntakeTrafficOptions,
  io: Output,
): Promise<number> {
  const sources = Object.keys(TRAFFIC_SOURCES).sort();
  if (!file) {
    io.err(
      `intake traffic needs an export file: atticus intake traffic <file> --source ${sources.join("|")} [--from YYYY-MM-DD --to YYYY-MM-DD]`,
    );
    return 2;
  }
  const columns = o.source ? TRAFFIC_SOURCES[o.source] : undefined;
  if (!columns) {
    io.err(
      `${o.source ? `${o.source} is no source Atticus reads` : "Say which source the export is from"}: --source ${sources.join("|")}.`,
    );
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    io.err(`No file at ${file}.`);
    return 2;
  }
  const bytes = new Uint8Array(await readFile(path));
  const { templates, apps } = await estateNames(root);
  const deny = await denyHashesAt(root);
  const r = aggregateTraffic({
    bytes,
    source: o.source!,
    columns,
    templates,
    apps,
    ...(o.from ? { from: o.from } : {}),
    ...(o.to ? { to: o.to } : {}),
    ...(deny.size ? { denyHashes: deny } : {}),
  });
  if (!r.ok) {
    io.err(`${basename(path)}: ${r.message}`);
    return 1;
  }
  const rel = `${evidenceRelOf(root)}/traffic/${trafficFileName(r.file)}`;
  await writeFileAtomic(join(evidenceDirOf(root), "traffic", trafficFileName(r.file)), r.text);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          written: rel,
          rows: r.file.rows.length,
          read: r.read,
          outOfRange: r.outOfRange,
          skipped: r.skipped,
          dropped: r.dropped,
          from: r.file.from,
          to: r.file.to,
          inputSha256: r.file.inputSha256,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    `Wrote ${rel}: ${r.file.rows.length} aggregate${r.file.rows.length === 1 ? "" : "s"} (caller app, method, path template, proxy and base path) from ${r.read} rows, ${r.file.from} to ${r.file.to}${r.outOfRange ? `; ${r.outOfRange} outside the range` : ""}${r.skipped ? `; ${r.skipped} without a method, path or count` : ""}${r.unmatched ? `; ${r.unmatched} to a path no route template of the estate matches, dropped` : ""}.`,
  );
  if (r.dropped.length)
    io.out(
      `  Dropped before anything was written: the columns ${r.dropped.join(", ")}, every query string and matrix param, any proxy that looked like an IP, an email or a token, and every path but as a route template of the estate. No raw row is kept.`,
    );
  io.out(
    `  Review it in a pull request (an app named like no component is written as an app-<hash> label: give its row a component: line), then atticus verify <repo> --write marks the links it shows used, and lists the traffic no link carries and the links none used.`,
  );
  return 0;
}

/**
 * The estate's route templates (the paths of every repo's verified entries and calls) and the
 * app names a traffic aggregate may keep: every repo, component and module id of the manifests
 * and facts, and the apps (and components) reviewers named in the aggregates already on file.
 */
async function estateNames(root: string): Promise<{ templates: string[]; apps: string[] }> {
  const { estateFacts, estateRepos } = await import("@maycombhq/scanner");
  const apps = new Set<string>();
  const tDir = join(evidenceDirOf(root), "traffic");
  for (const n of (await readdir(tDir).catch(() => [] as string[])).sort()) {
    if (!/\.ya?ml$/.test(n)) continue;
    const r = readTrafficFile(n, await readFile(join(tDir, n), "utf8"));
    if (r.ok)
      for (const row of r.traffic.file.rows)
        if (row.component) apps.add(row.app).add(row.component);
  }
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  if (!op) return { templates: [], apps: [...apps].sort() };
  for (const m of estateRepos(op)) {
    apps.add(m.id);
    if (m.component) apps.add(m.component);
    for (const x of m.modules ?? []) apps.add(x.component);
  }
  const { repos } = await estateFacts(root, op, "");
  const out = new Set<string>();
  for (const r of repos) {
    apps.add(r.repo);
    for (const f of r.facts) {
      if (f.component) apps.add(f.component);
      if (
        (f.kind === "entry" && f.entryType === "rest") ||
        (f.kind === "call" && f.callType === "rest")
      )
        if (f.path?.startsWith("/")) out.add(f.path);
    }
  }
  return { templates: [...out].sort(), apps: [...apps].sort() };
}

/** The metarepo's deny-list (`.denylist`: SHA-256 hashes, one a line), when it has one. */
export async function denyHashesAt(root: string): Promise<Set<string>> {
  const text = await readFile(join(root, ".denylist"), "utf8").catch(() => "");
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{64}$/.test(l)),
  );
}

/** A SHA-256 of a text (the deny-list's form), for tests and `--hash`-like use. */
export const denyHash = (s: string) =>
  createHash("sha256").update(s.trim().toLowerCase(), "utf8").digest("hex");
