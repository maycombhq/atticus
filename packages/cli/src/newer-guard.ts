import type { Output } from "./commands.js";

/**
 * Beta.28.2 (ADR 0197, "beta.28.1 and older reading version 2"): the writers of the build's
 * inputs, refused before they write anything when a newer Atticus built this metarepo's catalog
 * (`refuseIfNewer`). Each of them saves a curated decision, a correction, an answer, a file of
 * the org pack, a slot or the catalog itself, then builds: over a newer catalog the build would
 * refuse only after the file was saved. Their refusal is the build's own: `newer-atticus`, with
 * the words that say to upgrade Atticus and never to run `atticus upgrade`.
 */

/** `atticus <group> <command>` of each writer the command line has (`<group>` alone: any). */
export const NEWER_GUARDED_COMMANDS: ReadonlySet<string> = new Set([
  "alias",
  "baseline",
  "catalog build",
  "catalog edits",
  "catalog prune",
  "catalog undo",
  "feature link",
  "feature merge",
  "feature name",
  "feature split",
  "feature suggest-names",
  "feature tag",
  "glossary alias",
  "glossary define",
  "glossary link",
  "glossary scan",
  "initiative commit",
  "initiative new",
  "initiative plan",
  "initiative request",
  "intake add",
  "orgpack accept",
  "orgpack owner",
  "probe answer",
  "questions answer",
  "questions correct",
  "questions owner",
  "questions propose",
  "questions route",
  "questions undo",
  "repo add",
  "repo describe",
  "repo rename",
  "repo-type new",
  "repo-type note",
  "repo-type rules",
  "rules activate",
  "rules add",
  "rules import",
  "rules off",
  "scan",
  "triage decide",
  "types add",
  "types notes",
]);

/** Whether the command line's `atticus <group> <command>` is one of those writers. */
export function newerGuardedCommand(
  group: string | undefined,
  command: string | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!group) return false;
  // `verify <repo>` writes only with --write (a read alone writes nothing of the build's).
  if (group === "verify") return values.write === true;
  if (group === "scan") return command === undefined;
  // Read-only modes are not refused (review of beta.28.2): they write nothing of the build's.
  if (group === "absorb" && command === "accept") return values["dry-run"] !== true;
  if (group === "connect" && command === "match") return values.read !== true;
  // `catalog validate <folder> --fix` writes the records again; without --fix it only reads.
  if (group === "catalog" && command === "validate") return values.fix === true;
  // `atticus map <repo>` is the assistant's read, refused before it costs a model call;
  // `map render` only draws the map from the facts there are.
  if (group === "map") return command !== undefined && command !== "render";
  // `catalog migrate` writes the catalog's files again, but not with --dry-run.
  if (group === "catalog" && command === "migrate") return values["dry-run"] !== true;
  // `catalog crosscheck` reads, but its --promote, --dismiss and --undismiss write a decision.
  if (group === "catalog" && command === "crosscheck")
    return ["promote", "dismiss", "undismiss"].some((k) => values[k] !== undefined);
  return NEWER_GUARDED_COMMANDS.has(group) || NEWER_GUARDED_COMMANDS.has(`${group} ${command}`);
}

/** The local API's writers of the build's inputs, as `METHOD pattern` (409 over a newer catalog). */
export const NEWER_GUARDED_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/build",
  "POST /api/build/edits/curate",
  "POST /api/build/undo",
  "POST /api/build/prune",
  "POST /api/build/upgrade",
  "POST /api/upgrade",
  "POST /api/scan",
  "POST /api/facts/{repo}/apply",
  "POST /api/facts/apply-all",
  "POST /api/facts/{repo}/corrections",
  "POST /api/facts/{repo}/corrections/undo",
  "POST /api/crosscheck/{repo}/promote",
  "POST /api/crosscheck/{repo}/dismiss",
  "POST /api/baseline",
  "POST /api/links/corrections",
  "POST /api/links/delete",
  "POST /api/initiatives",
  "POST /api/initiatives/{initiativeId}/plan",
  "POST /api/commitments/{commitmentId}/status",
  "POST /api/owner-questions/{id}/send",
  "POST /api/runs",
  "POST /api/links/deleted/undo",
  "POST /api/links/connect",
  "POST /api/links/match",
  "POST /api/links/match/done",
  "POST /api/map/edits",
  "POST /api/reading-rules/from-pairing",
  "POST /api/boxes",
  "POST /api/declared-links",
  "POST /api/declared-links/undo",
  "POST /api/decisions/correct",
  "POST /api/decisions/batches/{batchId}/undo",
  "POST /api/triage/{itemId}/decide",
  "POST /api/questions/{id}/answer",
  "POST /api/questions/{id}/route",
  "POST /api/owner-questions/{id}/answer",
  "POST /api/trust/answer-boxes/ignore",
  "POST /api/trust/answer-boxes/rename",
  "POST /api/orgpack/draft/{platform}/accept",
  "POST /api/setup/repos",
  "PUT /api/setup/file",
  "PUT /api/orgpack/owner",
  "PUT /api/repos/{repo}/owner",
  "PUT /api/repos/{repoId}/branches",
  "PUT /api/repos/{repoId}/build",
  "PUT /api/repos/{repoId}/description",
  "PUT /api/repos/{repoId}/type",
]);

/**
 * The command line's refusal (exit 1, nothing written): the words on standard error, and with
 * `--json` the build's refusal shape. Undefined when the catalog is one this Atticus reads.
 */
export async function refuseNewerCommand(
  root: string,
  io: Output,
  json: boolean,
): Promise<number | undefined> {
  const { refuseIfNewer } = await import("@maycombhq/scanner");
  const r = await refuseIfNewer(root);
  if (!r) return undefined;
  io.err(r.message);
  if (json) io.out(JSON.stringify({ written: false, refused: r }, null, 2));
  return 1;
}
