import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  factsDirOf,
  factsRelOf,
  isAdopted,
  orgPackDirOf,
  parseFacts,
  serializeFacts,
} from "@maycombhq/core";
import { dirSource, verifyFacts } from "@maycombhq/verify";
import { createGit } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { repoFor } from "./onboard-commands.js";

/**
 * atticus verify <repo> (ADR 0124): check the facts the assistant wrote for a repo against the
 * repo's code at its commit. Reads `facts/<repo>.jsonl` (`.atticus/facts/` when adopted); writes
 * the kept facts back in canonical form marked verified, the rejected ones with their reasons to
 * `<repo>.rejected.jsonl` for the assistant to fix, and `<repo>.verify.yaml` with the coverage.
 * Exit code 1 while anything is rejected, so a reading loop knows to go again.
 */
export interface VerifyCommandOptions {
  /** The repo's checkout, when not the base clone or (adopted in place) the root itself. */
  dir?: string;
  /** The commit the facts must be of; default the checkout's HEAD. */
  commit?: string;
  /** Files the reader opened through Atticus's tools. */
  routed?: string[];
  /**
   * Write the kept facts into the catalog, the flows into specs/<repo>/ and render the map
   * (ADR 0124, A3b), only when nothing is rejected.
   */
  write?: boolean;
  json?: boolean;
}

async function headOf(dir: string): Promise<string | undefined> {
  try {
    const r = await createGit({ timeoutMs: 30_000 })(["rev-parse", "HEAD"], dir);
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Exclusion globs a person accepted for this repo (ADR 0075 scan settings). */
async function excludesOf(root: string, repo: string): Promise<string[]> {
  const file = join(orgPackDirOf(root), "scan", `${repo}.yaml`);
  if (!existsSync(file)) return [];
  try {
    const doc = parse(await readFile(file, "utf8")) as { exclude?: { path?: string }[] } | null;
    return (doc?.exclude ?? []).map((e) => e.path).filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

export async function verifyCommand(
  root: string,
  repo: string,
  o: VerifyCommandOptions,
  io: Output,
): Promise<number> {
  const rel = factsRelOf(root);
  const file = join(factsDirOf(root), `${repo}.jsonl`);
  if (!existsSync(file)) {
    io.err(
      `No facts for ${repo} at ${rel}/${repo}.jsonl. Run /atticus map in your assistant first; it writes that file.`,
    );
    return 2;
  }
  const parsed = parseFacts(await readFile(file, "utf8"));
  if (!parsed.ok) {
    io.err(`${rel}/${repo}.jsonl does not read as facts:`);
    for (const i of parsed.issues.slice(0, 20))
      io.err(`  ${i.line !== undefined ? `line ${i.line}: ` : ""}${i.message}`);
    if (parsed.issues.length > 20) io.err(`  ... and ${parsed.issues.length - 20} more`);
    return 2;
  }
  const dir = o.dir ?? (isAdopted(root) ? root : ((await repoFor(root, repo))?.dir ?? undefined));
  if (!dir) {
    io.err(
      `No checkout of ${repo}: clone it (atticus workspace sync) or give its folder with --dir.`,
    );
    return 2;
  }
  const commit = o.commit ?? (await headOf(dir));
  const report = await verifyFacts({
    facts: parsed.facts,
    source: dirSource(dir),
    ...(commit ? { commit } : {}),
    ...(o.routed ? { routed: o.routed } : {}),
    exclude: await excludesOf(root, repo),
  });

  await mkdir(factsDirOf(root), { recursive: true });
  await writeFile(file, serializeFacts(report.accepted), "utf8");
  const rejectedFile = join(factsDirOf(root), `${repo}.rejected.jsonl`);
  if (report.rejected.length)
    await writeFile(
      rejectedFile,
      report.rejected
        .map((r) => JSON.stringify({ code: r.code, message: r.message, fact: r.fact }))
        .join("\n") + "\n",
      "utf8",
    );
  else await rm(rejectedFile, { force: true });
  const summary = {
    repo,
    ...(commit ? { commit } : {}),
    accepted: report.accepted.length,
    rejected: report.rejected.length,
    redacted: report.redacted,
    coverage: {
      ratio: report.coverage.ratio,
      read: report.coverage.read.length,
      unknown: report.coverage.unknown,
      excluded: report.coverage.excluded,
    },
    rejections: report.rejected.map((r) => ({ id: r.fact.id, code: r.code, message: r.message })),
  };
  await writeFile(join(factsDirOf(root), `${repo}.verify.yaml`), stringify(summary), "utf8");

  // --write (ADR 0124, A3b): the kept facts become the catalog, only when none was rejected,
  // so a half-fixed read never replaces the repo's records.
  const rejectedNote = `Nothing written to the catalog: ${report.rejected.length} facts were rejected. Fix them and run atticus verify ${repo} --write again.`;
  if (o.json) {
    let written;
    if (o.write && !report.rejected.length) {
      const { writeFactsIntoCatalog } = await import("./map-commands.js");
      written = await writeFactsIntoCatalog(
        root,
        repo,
        report.accepted,
        { dir, command: `atticus verify ${repo} --write` },
        { ...io, out: () => undefined },
      );
      if (!written) return 1;
    } else if (o.write) io.err(rejectedNote);
    io.out(JSON.stringify({ ...summary, ...(written ? { written } : {}) }, null, 2));
    return report.rejected.length ? 1 : 0;
  }
  const pct = Math.round(report.coverage.ratio * 100);
  io.out(
    `${repo}: ${report.accepted.length} facts kept, ${report.rejected.length} rejected; coverage ${pct}% (${report.coverage.read.length} read, ${report.coverage.unknown.length} unknown${report.coverage.excluded.length ? `, ${report.coverage.excluded.length} excluded` : ""}).`,
  );
  for (const r of report.rejected.slice(0, 15)) io.out(`  ${r.code}: ${r.message}`);
  if (report.rejected.length > 15) io.out(`  ... and ${report.rejected.length - 15} more`);
  if (report.rejected.length)
    io.out(
      `Fix them from ${rel}/${repo}.rejected.jsonl (read the lines again, then rewrite or drop each fact) and run atticus verify ${repo} again.`,
    );
  else if (report.coverage.unknown.length)
    io.out(
      `Next: read the ${report.coverage.unknown.length} unknown files (listed in ${rel}/${repo}.verify.yaml), or exclude generated code in org-pack/scan/${repo}.yaml.`,
    );
  if (report.redacted) io.out(`${report.redacted} quotes had a secret value redacted.`);
  if (report.rejected.length) {
    if (o.write) io.err(rejectedNote);
    return 1;
  }
  if (!o.write) {
    io.out(
      `When the read is complete: atticus verify ${repo} --write puts the facts in the catalog, the flows in specs/${repo}/, and renders the map.`,
    );
    return 0;
  }
  // Loaded here: the catalog writer brings the scanner, which a check alone never needs.
  const { writeFactsIntoCatalog } = await import("./map-commands.js");
  const written = await writeFactsIntoCatalog(
    root,
    repo,
    report.accepted,
    { dir, command: `atticus verify ${repo} --write` },
    io,
  );
  return written ? 0 : 1;
}
