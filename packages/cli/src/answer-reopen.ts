import { stat } from "node:fs/promises";
import { join } from "node:path";
import { factIdPart, factsDirOf, type OrgPack } from "@maycombhq/core";
import { estateRepos } from "@maycombhq/scanner";
import type { GitRunner } from "@maycombhq/workspace";
import { estateFreshness } from "./estate-fresh.js";
import { readPlanProgress } from "./map-parts.js";

/**
 * ADR 0162 (F8), review item 9: an answer is opened again only when the repo it names is read
 * whole and fresh. A facts file alone isn't enough: a read stopped partway (the read plan's parts
 * not all read, ADR 0161), a second pass planned and not read yet (`<repo>.gaps.md` newer than
 * the facts, ADR 0157), or facts of an older commit than the clone's (`atticus estate fresh`
 * says other than fresh) may lack the very route that serves the call.
 */

/** The manifest repo a miss's target names (its id, component or a module's component). */
export function repoOfTarget(op: OrgPack, target: string): string {
  const t = factIdPart(target);
  const r = estateRepos(op).find(
    (x) =>
      factIdPart(x.id) === t ||
      (x.component !== undefined && factIdPart(x.component) === t) ||
      (x.modules ?? []).some((m) => factIdPart(m.component) === t),
  );
  return r?.id ?? target;
}

const mtimeOf = async (path: string) => (await stat(path).catch(() => undefined))?.mtimeMs;

/** Why the repo's read can't yet be trusted to disagree with an answer; undefined when it can. */
export async function readNotSettled(
  root: string,
  repo: string,
  o: { git?: GitRunner } = {},
): Promise<string | undefined> {
  const plan = await readPlanProgress(root, repo);
  if (plan && (plan.stale || plan.done < plan.total))
    return plan.stale
      ? `its read plan is of another commit (${plan.commit})`
      : `${plan.total - plan.done} of the ${plan.total} parts of its read plan are not read yet`;
  const dir = factsDirOf(root);
  const gaps = await mtimeOf(join(dir, `${repo}.gaps.md`));
  const facts = await mtimeOf(join(dir, `${repo}.jsonl`));
  if (gaps !== undefined && (facts === undefined || gaps >= facts))
    return `its second pass (atticus map ${repo} --gaps) is planned and not read yet`;
  const fresh = (await estateFreshness(root, { repos: [repo], ...(o.git ? { git: o.git } : {}) }))
    .repos[0];
  if (!fresh || fresh.state !== "fresh")
    return `its facts aren't fresh (atticus estate fresh says ${fresh?.state ?? "not-read"})`;
  return undefined;
}
