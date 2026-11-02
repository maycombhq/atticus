import {
  loadOrgPack,
  notesFor,
  orgPackDirOf,
  type NumberedNote,
  type OrgPack,
  type RepoType,
} from "@maycombhq/core";
import { estateRepos, matchRepoType } from "@maycombhq/scanner";
import { fsRepo } from "@maycombhq/sdk";

/**
 * The org notes a read of a repo is handed (ADR 0163): its repo type's, then the org-wide ones
 * in conventions.yaml. The type is the manifest's, when it names a repo type of the pack, else
 * the one the repo's fingerprint matches (`atticus repo-type detect`), clearly or in part; a tie
 * or no match gives only the org-wide notes. Deterministic: the same checkout and pack give the
 * same notes, so the read and its verify agree on the numbers.
 */
export async function repoTypeOf(
  op: OrgPack,
  repo: string,
  dir: string | undefined,
): Promise<RepoType | undefined> {
  const named = estateRepos(op).find((r) => r.id === repo)?.type;
  const byName = op.repoTypes.find((t) => t.id === named);
  if (byName) return byName;
  if (!dir || !op.repoTypes.length) return undefined;
  const r = await matchRepoType(fsRepo(repo, dir, "0".repeat(40)), op.repoTypes).catch(
    () => undefined,
  );
  return r && (r.verdict === "clear" || r.verdict === "partial")
    ? op.repoTypes.find((t) => t.id === r.best)
    : undefined;
}

export interface RepoNotes {
  /** The repo type the notes are of, when one is. */
  type?: string;
  notes: NumberedNote[];
}

/** The notes for one repo, from the org pack given or the one at `root`. */
export async function notesAt(
  root: string,
  repo: string,
  dir: string | undefined,
  given?: OrgPack,
): Promise<RepoNotes> {
  const op = given ?? (await loadOrgPack(orgPackDirOf(root)).catch(() => undefined));
  if (!op) return { notes: [] };
  const type = await repoTypeOf(op, repo, dir);
  return { ...(type ? { type: type.id } : {}), notes: notesFor(type, op.conventions) };
}
