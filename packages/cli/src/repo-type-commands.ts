import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isScalar, visit } from "yaml";
import { loadOrgPack, orgPackDirOf, RecordId } from "@maycombhq/core";
import { draftRepoType, matchRepoType, type RepoTypeMatches } from "@maycombhq/scanner";
import { fsRepo } from "@maycombhq/sdk";
import type { Output } from "./commands.js";
import { repoFor } from "./onboard-commands.js";

/**
 * atticus repo-type (ADR 0077): match a repo against the org pack's repo types by fingerprint,
 * and draft a new type from a repo. Both deterministic; no AI.
 */

const pct = (n: number) => `${Math.round(n * 100)}%`;
const notFound = (target: string) =>
  `${target} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`;

function verdictLine(id: string, r: RepoTypeMatches): string {
  const best = r.matches.find((m) => m.type === r.best);
  switch (r.verdict) {
    case "clear":
      return `${id} is a clear match for ${best!.name} (${best!.type}), ${pct(best!.score)}. Reuse it: atticus scan survey ${id} hands its settings and skills to your assistant.`;
    case "partial":
      return `${id} is a partial match for ${best!.name} (${best!.type}), ${pct(best!.score)}. Reuse it, and extend the type with what this repo does differently.`;
    case "tie":
      return `${id} matches ${r.tied!.join(" and ")} about as well.${r.fromDescription ? ` Its description says "${r.fromDescription.words}", so ${r.fromDescription.type} is the likelier of them; a person still decides.` : ""} A person decides which it is; then change the types so their fingerprints tell them apart.`;
    case "none":
      return `${id} matches no known repo type.${r.fromDescription ? ` Its description says "${r.fromDescription.words}", so ${r.fromDescription.type} may be it, though nothing in its files says so.` : ""} Draft one: atticus repo-type new <id> --from ${id}`;
  }
}

/** The type as YAML a person can read: short lists on one line, long text unfolded. */
function typeYaml(t: object): string {
  const doc = new Document(t);
  visit(doc, {
    Seq(_, node) {
      if (node.items.every((i) => isScalar(i))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** atticus repo-type detect <repo> [--json]: the ranked matches, with the evidence for each. */
export async function repoTypeDetect(
  root: string,
  target: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const repo = await repoFor(root, target);
  if (!repo) {
    io.err(notFound(target));
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  // What a person says the repo is (ADR 0128): read only to lean a tie or suggest where the
  // fingerprints found nothing, never to overrule what the files say.
  const said = op.profiles.flatMap((p) => p.repos?.repos ?? []).find((x) => x.id === repo.id)
    ?.description?.text;
  const r = await matchRepoType(fsRepo(repo.id, repo.dir, "0".repeat(40)), op.repoTypes, {
    ...(said ? { description: said } : {}),
  });
  if (o.json) {
    io.out(JSON.stringify({ repo: repo.id, ...r }, null, 2));
    return 0;
  }
  if (op.repoTypes.length === 0) {
    io.out(
      `The org pack has no repo types yet (org-pack/repo-types/<id>/type.yaml). Draft one: atticus repo-type new <id> --from ${repo.id}`,
    );
    return 0;
  }
  io.out(verdictLine(repo.id, r));
  for (const m of r.matches) {
    io.out(
      `  ${m.type}  ${pct(m.score)} (${m.got} of ${m.total})${m.ruledOut ? ", ruled out: a required signal is missing" : ""}`,
    );
    for (const s of m.signals)
      io.out(
        `    ${s.found ? "found  " : "missing"}  ${s.label} (${s.weight}${s.required ? ", required" : ""})${s.found ? `: ${s.evidence.join(", ")}` : ""}`,
      );
  }
  return 0;
}

/** atticus repo-type new <id> --from <repo> [--force]: draft a type from a repo, to edit. */
export async function repoTypeNew(
  root: string,
  id: string,
  o: { from?: string; force?: boolean; now?: Date },
  io: Output,
): Promise<number> {
  if (!RecordId.safeParse(id).success || !o.from) {
    io.err(
      "Usage: atticus repo-type new <id> --from <repo> [--force]. The id is a lowercase slug, like forge-spring-service.",
    );
    return 2;
  }
  const repo = await repoFor(root, o.from);
  if (!repo) {
    io.err(notFound(o.from));
    return 2;
  }
  const dir = join(orgPackDirOf(root), "repo-types", id);
  const file = join(dir, "type.yaml");
  if (!o.force && (await stat(file).catch(() => undefined))) {
    io.err(
      `The repo type ${id} already exists (org-pack/repo-types/${id}/type.yaml). Re-run with --force to draft it again.`,
    );
    return 1;
  }
  const t = await draftRepoType(fsRepo(repo.id, repo.dir, "0".repeat(40)), id);
  if (!t) {
    io.out(
      `${repo.id} has no build file, dependency, framework marker or known folder to fingerprint; nothing was written. Write the type by hand.`,
    );
    return 1;
  }
  await mkdir(dir, { recursive: true });
  const date = (o.now ?? new Date()).toISOString().slice(0, 10);
  await writeFile(
    file,
    `# Drafted from ${repo.id} by atticus repo-type new on ${date} (ADR 0077). Edit it: name what kind\n# of repo this is, keep the signals every repo of the kind has, set the weights, add skills.\n${typeYaml(t)}`,
    "utf8",
  );
  const kinds = new Map<string, number>();
  for (const s of t.fingerprint) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  io.out(
    `Wrote org-pack/repo-types/${id}/type.yaml from ${repo.id}: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")} ${t.fingerprint.length === 1 ? "signal" : "signals"}, ${t.settings.prefixes.length} prefix ${t.settings.prefixes.length === 1 ? "rule" : "rules"}.`,
  );
  io.out(
    `Next: edit it, check it with atticus repo-type detect ${repo.id} and atticus orgpack validate, then review it in a pull request.`,
  );
  return 0;
}
