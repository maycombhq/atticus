import { resolve } from "node:path";
import {
  absorb,
  acceptAbsorbed,
  adopt,
  AdoptError,
  init,
  refreshAbsorbed,
  refreshAllAbsorbed,
  reposDiscover,
  unadopt,
  zeroInstallFiles,
  checkZeroInstall,
  type Action,
  type RefreshResult,
  type RepoListing,
} from "@maycombhq/adopt";
import { assistantTier, tierLine } from "@maycombhq/assistant-files";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * ADR 0124 §4: the tier the org pack's assistant reads a repo at, said once at set-up, with where
 * to see what the first read costs. Nothing when the org pack can't be read.
 */
async function tierAt(root: string, io: Output): Promise<void> {
  try {
    const op = await loadOrgPack(orgPackDirOf(root));
    io.out(`Your assistant reads a repo at: ${tierLine(assistantTier(op.runtime))}`);
  } catch {
    // the org pack's own problems are reported above
  }
}

/**
 * Setup commands: `init`, `adopt`, `unadopt`, `repos discover`, `absorb`, and the zero-install
 * assistant files for an adopted repo. Exit codes: 0 done, 1 problems, 2 usage.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function fail(io: Output, e: unknown): number {
  if (e instanceof AdoptError) {
    io.err(e.message);
    return e.code === "usage" ? 2 : 1;
  }
  io.err((e as Error).message);
  return 1;
}

/** atticus init <name> --platform <pack> [--from <org pack>] [--owner who] */
export async function initCommand(
  dir: string,
  o: { name?: string; platform?: string; packFrom?: string; owner?: string; json?: boolean },
  io: Output,
): Promise<number> {
  if (!o.name || !o.platform) {
    io.err("Usage: atticus init <name> --platform <platform> [--from <org pack folder>]");
    return 2;
  }
  try {
    const r = await init(dir, {
      name: o.name,
      platform: o.platform,
      ...(o.packFrom ? { packFrom: resolve(o.packFrom) } : {}),
      ...(o.owner ? { owner: o.owner } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return r.problems.length ? 1 : 0;
    }
    io.out(`Created the ${o.name} metarepo in ${dir} (${plural(r.created.length, "file")}).`);
    io.out(
      r.openspec === "cli"
        ? "OpenSpec is set up with the org-flow schema."
        : "openspec/ was made as folders with the org-flow schema.",
    );
    if (r.openspecNote) io.out(r.openspecNote);
    for (const p of r.problems)
      io.err(`org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
    for (const q of r.questions) io.out(`Question: ${q}`);
    await tierAt(dir, io);
    io.out(
      "Next: atticus repos discover <folder of clones>, then atticus workspace sync and atticus scan.",
    );
    return r.problems.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus adopt <path> [--platform id] [--json]: adopt an existing repo in place. */
export async function adoptCommand(
  path: string,
  o: { json?: boolean; platform?: string; name?: string },
  io: Output,
): Promise<number> {
  try {
    const r = await adopt(path, {
      ...(o.platform ? { platform: o.platform } : {}),
      ...(o.name ? { name: o.name } : {}),
    });
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            root: r.root,
            platform: r.platform,
            detected: r.detected,
            layout: r.layout,
            repos: r.repos.map((x) => ({ ...x.entry, signals: x.detection.signals })),
            questions: r.questions,
            written: r.written,
            problems: r.problems,
            ms: r.ms,
          },
          null,
          2,
        ),
      );
      return r.problems.length ? 1 : 0;
    }
    const d = r.detected;
    const found = [
      d.openspec ? `OpenSpec in ${d.openspec}/` : undefined,
      d.speckit ? "Spec Kit (.specify/)" : undefined,
      d.constitution ? `a constitution (${d.constitution})` : undefined,
      d.prompts.length ? `prompts in ${d.prompts.join(", ")}` : undefined,
      d.agents.length ? `agents in ${d.agents.join(", ")}` : undefined,
      d.skills.length ? `skills in ${d.skills.join(", ")}` : undefined,
      d.catalog ? `a catalog in ${d.catalog}/` : undefined,
    ].filter(Boolean);
    io.out(
      `Adopted ${r.root} in place in ${(r.ms / 1000).toFixed(1)} s. No file of the repo was changed.`,
    );
    io.out(
      found.length
        ? `Found ${found.join("; ")}.`
        : "Found no OpenSpec, Spec Kit or assistant files.",
    );
    io.out(`Repos: ${r.repos.map((x) => `${x.entry.id} (${x.entry.type})`).join(", ") || "none"}.`);
    io.out(
      `Everything Atticus owns is in .atticus/: the org pack points at what exists (openspec: ${r.layout.openspec}, catalog: ${r.layout.catalog}).`,
    );
    for (const p of r.problems)
      io.err(`.atticus/org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
    if (r.questions.length)
      io.out(
        `${plural(r.questions.length, "question")} for people are in .atticus/proposals/repos/${r.platform}/QUESTIONS.md.`,
      );
    await tierAt(r.root, io);
    io.out(`Next: atticus scan --root ${path}. To remove Atticus: atticus unadopt ${path}.`);
    return r.problems.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus unadopt <path>: remove only Atticus's folders and files; prints what it removed. */
export async function unadoptCommand(path: string, io: Output): Promise<number> {
  try {
    const r = await unadopt(path);
    for (const f of r.removed) io.out(`Removed ${f}`);
    for (const f of r.restored) io.out(`Took Atticus's section out of ${f}`);
    for (const f of r.keptNew) io.out(`Kept ${f} (added since adoption, not Atticus's)`);
    for (const f of r.changed) io.out(`Kept ${f} (changed since adoption)`);
    for (const f of r.missing) io.out(`Note: ${f} was deleted since adoption`);
    if (!r.hadSnapshot)
      io.out(
        "There was no adoption snapshot, so only files that are certainly Atticus's were removed.",
      );
    io.out(
      r.changed.length || r.keptNew.length || r.missing.length
        ? "Atticus is removed. The files above changed after adoption and were left as they are."
        : "Atticus is removed; every other file is as it was before adoption.",
    );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus repos discover <folder> | --org <org>: propose repos.manifest.yaml entries. */
export async function reposDiscoverCommand(
  root: string,
  o: {
    from?: string;
    org?: string;
    host?: RepoListing;
    platform?: string;
    dryRun?: boolean;
    json?: boolean;
  },
  io: Output,
): Promise<number> {
  if (!o.from && !o.org) {
    io.err("Usage: atticus repos discover <folder of clones> | --org <organisation>");
    return 2;
  }
  if (o.org && !o.host) {
    io.err(
      "Listing an organisation needs a Git host adapter that can list repos, and none is configured. Point at a folder of clones instead.",
    );
    return 2;
  }
  try {
    const r = await reposDiscover(
      root,
      o.org ? { host: o.host!, org: o.org } : { dir: resolve(o.from!) },
      { ...(o.platform ? { platform: o.platform } : {}), ...(o.dryRun ? { dryRun: true } : {}) },
    );
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            platform: r.platform,
            repos: r.repos.map((x) => ({ ...x.entry, signals: x.detection.signals })),
            skipped: r.skipped,
            questions: r.questions,
            wrote: r.wrote,
            file: r.file,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    for (const x of r.repos)
      io.out(
        `  ${x.entry.id}: ${x.entry.type}${x.detection.signals[0] ? ` (${x.detection.signals[0]})` : ""}`,
      );
    for (const s of r.skipped) io.out(`  Skipped ${s.path}: ${s.reason}`);
    io.out(
      r.wrote === "manifest"
        ? `Wrote ${plural(r.repos.length, "repo")} to ${r.file}.`
        : r.wrote === "proposal"
          ? `A manifest exists, so it was left as it is; the proposal is in ${r.file}.`
          : `Found ${plural(r.repos.length, "repo")}; nothing written (dry run).`,
    );
    if (r.questions.length)
      io.out(
        `${plural(r.questions.length, "question")} need a person${r.questionsFile ? `: ${r.questionsFile}` : ""}.`,
      );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

function reportRefresh(r: RefreshResult, io: Output): void {
  const s = r.source;
  const i = r.items;
  if (
    !s.added.length &&
    !s.removed.length &&
    !s.changed.length &&
    !i.added.length &&
    !i.removed.length &&
    !i.changed.length
  ) {
    io.out(`Refreshed ${r.id} from ${r.entry.url}: nothing changed since the last absorb.`);
    return;
  }
  io.out(
    `Refreshed ${r.id} from ${r.entry.url}: ${plural(s.added.length, "file")} added, ${s.removed.length} removed and ${s.changed.length} changed in the source.`,
  );
  for (const f of s.added) io.out(`  + ${f}`);
  for (const f of s.removed) io.out(`  - ${f}`);
  for (const f of s.changed) io.out(`  ~ ${f}`);
  io.out(
    `Items: ${i.added.length} new, ${i.removed.length} gone, ${i.changed.length} with a different action.`,
  );
  for (const x of i.added) io.out(`  + ${x}`);
  for (const x of i.removed) io.out(`  - ${x}`);
  for (const x of i.changed) io.out(`  ~ ${x.id}: ${x.from} to ${x.to}`);
  if (r.result.proposal)
    io.out(`Rewrote the proposal in ${r.result.proposal}/; review it as before.`);
}

/** atticus absorb --refresh <id>: fetch a linked source again and say what changed. */
export async function absorbRefreshCommand(
  root: string,
  id: string | undefined,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus absorb --refresh <id>");
    return 2;
  }
  try {
    const r = await refreshAbsorbed(root, id);
    if (o.json)
      io.out(
        JSON.stringify(
          {
            id: r.id,
            entry: r.entry,
            source: r.source,
            files: r.files,
            items: r.items,
            proposal: r.result.proposal,
          },
          null,
          2,
        ),
      );
    else reportRefresh(r, io);
    for (const p of r.result.problems) io.err(`  ${p}`);
    return r.result.problems.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus sources refresh: refresh every source sources.yaml absorbs with mode link. */
export async function sourcesRefreshCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  try {
    const all = await refreshAllAbsorbed(root);
    if (o.json)
      io.out(
        JSON.stringify(
          all.map((r) => ({ id: r.id, source: r.source, files: r.files, items: r.items })),
          null,
          2,
        ),
      );
    else if (!all.length) io.out("No linked absorbed sources in sources.yaml; nothing to refresh.");
    else for (const r of all) reportRefresh(r, io);
    const problems = all.flatMap((r) => r.result.problems.map((p) => `${r.id}: ${p}`));
    for (const p of problems) io.err(`  ${p}`);
    return problems.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus absorb accept <id> [--replace] [--dry-run] [--json]: the reviewed proposal into the metarepo. */
export async function absorbAcceptCommand(
  root: string,
  id: string,
  o: { replace?: boolean; dryRun?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus absorb accept <id> [--replace] [--dry-run]");
    return 2;
  }
  try {
    const r = await acceptAbsorbed(root, id, {
      ...(o.replace ? { replace: true } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify({ ...r, dryRun: o.dryRun === true }, null, 2));
      return 0;
    }
    const would = o.dryRun ? "Would copy" : "Copied";
    io.out(
      `${would} ${plural(r.copied.length, "file")} from ${r.proposal}/ into the metarepo${r.same.length ? ` (${r.same.length} already there)` : ""}; ${plural(r.linked, "item")} stay linked.`,
    );
    for (const f of r.copied) io.out(`  ${f}`);
    if (r.kept.length) {
      io.out(
        `Kept ${plural(r.kept.length, "file")} that already differ (--replace overwrites them):`,
      );
      for (const f of r.kept) io.out(`  ${f}`);
    }
    io.out(
      r.entry === "already"
        ? `${r.sourcesFile} already lists ${id}.`
        : `${o.dryRun ? "Would add" : r.entry === "added" ? "Added" : "Replaced"} ${id} under absorbed: in ${r.sourcesFile}.`,
    );
    if (!o.dryRun && (r.copied.length || r.entry !== "already"))
      io.out("Commit these through a pull request: merging it is the approval.");
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus absorb <git-url|path> --id <id> [--mode adopt|link|ignore] [--ref r] [--json] */
export async function absorbCommand(
  root: string,
  url: string,
  o: { id?: string; mode?: string; ref?: string; json?: boolean; dryRun?: boolean },
  io: Output,
): Promise<number> {
  if (!url || !o.id) {
    io.err("Usage: atticus absorb <git-url|path> --id <id> [--mode adopt|link|ignore]");
    return 2;
  }
  if (o.mode && !["adopt", "link", "ignore"].includes(o.mode)) {
    io.err(`--mode is adopt, link or ignore, not ${o.mode}.`);
    return 2;
  }
  try {
    const r = await absorb(root, url, {
      id: o.id,
      ...(o.mode ? { mode: o.mode as Action } : {}),
      ...(o.ref ? { ref: o.ref } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
    });
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            id: r.id,
            format: r.format,
            entry: r.entry,
            summary: r.summary,
            items: r.items.map(({ artifact, ...i }) => ({
              ...i,
              ...(artifact ? { artifact: artifact.path } : {}),
            })),
            proposal: r.proposal,
            files: r.files,
            problems: r.problems,
            ms: r.ms,
          },
          null,
          2,
        ),
      );
      return r.problems.length ? 1 : 0;
    }
    const s = r.summary;
    io.out(
      `Absorbed ${url} as ${r.id} (${r.format}): ${plural(s.items, "item")}, ${s.byAction.adopt} adopt, ${s.byAction.link} link, ${s.byAction.ignore} ignore.`,
    );
    for (const i of r.items)
      io.out(
        `  ${i.action.padEnd(6)} ${i.kind.padEnd(22)} ${i.path}${i.line ? `:${i.line}` : ""}  ${i.reason}`,
      );
    io.out(`Translated ${s.translated} of ${s.translatable} items (${s.translatedPercent}%).`);
    for (const p of r.problems) io.err(`  ${p}`);
    if (r.proposal)
      io.out(
        `Wrote the proposal to ${r.proposal}/ (${plural(r.files.length, "file")}): PR.md is the pull request description; nothing in the org pack was changed.`,
      );
    return r.problems.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/**
 * atticus assistant-files for a repo adopted in place: the zero-install commands, pointing at
 * `.atticus/org-pack/`, written into the repo's assistant folders, then checked: every file a
 * command points at must exist in the committed tree.
 */
export async function zeroInstallCommand(
  root: string,
  o: { check?: boolean; force?: boolean },
  io: Output,
): Promise<number> {
  try {
    const r = await zeroInstallFiles(root, o);
    for (const w of r.results.filter((x) => x.action !== "unchanged"))
      io.out(`  ${w.action}: ${w.path}`);
    const problems = await checkZeroInstall(
      root,
      r.files.map((f) => ({ path: f.path, content: f.content })),
    );
    for (const p of problems) io.err(`${p.file} points at ${p.missing}, which doesn't exist.`);
    if (o.check)
      io.out(
        r.upToDate ? "The assistant files are up to date." : "The assistant files are out of date.",
      );
    else
      io.out(
        `Wrote the assistant files (${plural(r.files.length, "file")}); commit them for zero-install use.`,
      );
    return problems.length || (o.check && !r.upToDate) ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}
