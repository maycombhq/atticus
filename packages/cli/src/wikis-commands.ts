import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { acceptStandardChecks, draftStandardChecks, estimateScan } from "@maycombhq/knowledge";
import type { Output } from "./commands.js";

/**
 * Many wikis (ADR 0132): what a knowledge scan would cost before it runs, and standards made into
 * critic checks a person accepts.
 *
 * - `atticus sources estimate [--source s] [--batch-tokens n] [--full] [--json]`: per source, the
 *   pages of its newest snapshot, those the next scan reads (new or changed, within its
 *   `maxPages`), their tokens and the model calls; then the whole. Nothing is read from a wiki or
 *   sent to a model. Exit 2 when nothing is synced yet.
 * - `atticus standards propose [--json]`: each rule of a confirmed standard from a standard source,
 *   proposed as a critic check (proposals/checklists/standards.yaml). Nothing is enforced.
 * - `atticus standards accept [--only id,id] [--dry-run] [--json]`: the checks a person picks, into
 *   org-pack/checklists/standards.yaml, to commit through a pull request.
 */

const plural = (n: number, w: string) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function sourcesEstimate(
  root: string,
  o: { source?: string; batchTokens?: number; full?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(orgPackDirOf(root));
  if (o.source && !op.sources.wikis.some((w) => w.id === o.source)) {
    io.err(`There is no source ${o.source} in org-pack/sources.yaml.`);
    return 2;
  }
  const pack = o.source
    ? {
        ...op,
        sources: { ...op.sources, wikis: op.sources.wikis.filter((w) => w.id === o.source) },
      }
    : op;
  const e = await estimateScan(root, {
    orgPack: pack,
    ...(o.batchTokens ? { batchTokens: o.batchTokens } : {}),
    ...(o.full ? { full: true } : {}),
  });
  if (o.json) {
    io.out(JSON.stringify(e, null, 2));
    return e.sources.length ? 0 : 2;
  }
  if (!e.sources.length) {
    io.err(
      "There is no snapshot yet. Run atticus sources sync first: the estimate reads the snapshots.",
    );
    return 2;
  }
  io.out(
    `A knowledge scan would read ${plural(e.total.toRead, "page")} of ${plural(e.total.pages, "page")}, about ${plural(e.total.tokens, "token")}, in ${plural(e.total.calls, "model call")} (each call up to ${plural(e.room, "token")} of pages):`,
  );
  for (const s of e.sources)
    io.out(
      `  ${s.source}: ${plural(s.toRead, "page")} to read of ${s.pages}${s.unchanged ? ` (${s.unchanged} as at the last scan)` : ""}, about ${plural(s.tokens, "token")}, ${plural(s.calls, "call")} on its own${s.capped ? `; ${s.capped} wait for a later run (maxPages ${s.cap})` : ""}`,
    );
  for (const id of e.notSynced)
    io.out(`  ${id}: not synced yet (atticus sources sync --source ${id})`);
  io.out(
    "Each call is one prompt to the configured model (with Copilot, one premium request). Cap a source with maxPages in sources.yaml; atticus knowledge scan reads the rest on a later run.",
  );
  return 0;
}

export async function standardsCli(
  root: string,
  command: string | undefined,
  values: Record<string, unknown>,
  io: Output,
): Promise<number> {
  const json = values.json === true;
  try {
    if (command === "propose") {
      const d = await draftStandardChecks(root);
      if (json) {
        io.out(JSON.stringify(d, null, 2));
        return 0;
      }
      if (!d.proposals.length) io.out("No rule of a confirmed standard waits to be accepted.");
      else {
        io.out(
          `${plural(d.proposals.length, "critic check")} proposed from confirmed standards (nothing is enforced until accepted):`,
        );
        for (const p of d.proposals)
          io.out(
            `  ${p.rule.id} (${p.rule.severity}): ${p.rule.title} [${p.page}, confirmed by ${p.verifiedBy}]`,
          );
      }
      for (const l of d.left) io.out(`  not proposed: ${l.item}: ${l.why}`);
      io.out(
        `Written to ${d.file} and ${d.file.replace(/\.yaml$/, ".md")}. Accept them with atticus standards accept [--only id,id].`,
      );
      return 0;
    }
    if (command === "accept") {
      const only = str(values.only)
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const r = await acceptStandardChecks(root, {
        ...(only ? { only } : {}),
        ...(values["dry-run"] === true ? { dryRun: true } : {}),
      });
      if (json) {
        io.out(JSON.stringify(r, null, 2));
        return 0;
      }
      const would = values["dry-run"] === true;
      io.out(
        `${would ? "Would add" : "Added"} ${r.added.length ? r.added.join(", ") : "no check"} to ${r.file}; ${r.left} left proposed.`,
      );
      if (!would && r.added.length)
        io.out(
          "Commit the checklist through a pull request: merging it is the approval, and the critic runs it from then on.",
        );
      return 0;
    }
    io.err(
      "Usage: atticus standards propose | atticus standards accept [--only id,id] [--dry-run]",
    );
    return 2;
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
}
