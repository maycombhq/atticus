import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  joinConventions,
  factIdPart,
  factsDirOf,
  joinFacts,
  loadOrgPack,
  orgPackDirOf,
  parseFacts,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { estateRepos, joinReposOf, outsideSystems } from "@maycombhq/scanner";

/**
 * The onboarding queue (plan item P6, ADR 0141): the repos to read next, in the order that makes
 * links land early. A call is joined only once the repo that serves it is read, so a repo the
 * repos already read call, or a gateway proxy their calls go through, is read before the rest:
 * reading it lands every link waiting on it. What the queue rests on is said for each repo:
 *
 * - **started**: its read is under way (facts on file, or parts of its read plan done): finish it;
 * - **called**: the estate join, run over the facts on file with the repos not read yet as ends
 *   with no entries, leaves calls of read repos waiting on it (a call naming its repo or component,
 *   or a host and base path its manifest lists), by how many repos;
 * - **gateway**: its manifest type is a gateway (`gateway`, `gateway-external`, ...), so the calls
 *   through it join once it is read;
 * - **places**: its manifest type is a deploy or config repo (`deploy`, `config`, `deploy-config`,
 *   ...): its Routes, Ingresses and values say where other repos are reached (ADR 0143) and set
 *   their config placeholders (J0), so links land once it is read;
 * - **next**: nothing says yet: in the manifests' order.
 *
 * Files only: the manifests, the facts files and the org pack. It runs and calls nothing.
 */

export type QueueReason = "started" | "called" | "gateway" | "places" | "next";

export interface QueueRepo {
  repo: string;
  /** Its read is under way. */
  started?: boolean;
  /** Its manifest type is a gateway. */
  gateway?: boolean;
  /** Its manifest type is a deploy or config repo: it says where other repos are reached. */
  places?: boolean;
  /** The read repos whose calls wait on it, sorted. */
  callers?: string[];
  /** Its place in the manifests: the order among repos nothing else ranks. */
  index: number;
}

/** Why a repo sits where it does, from what ranks it. */
export const reasonOf = (r: QueueRepo): QueueReason =>
  r.started
    ? "started"
    : r.callers?.length
      ? "called"
      : r.gateway
        ? "gateway"
        : r.places
          ? "places"
          : "next";

/**
 * The order to read in: reads under way first; then the repos the most read repos call, a gateway
 * first among the same; then gateways; then deploy and config repos; then the rest in the manifests' order. Pure and stable.
 */
export function queueOrder(a: QueueRepo, b: QueueRepo): number {
  const rank = (r: QueueRepo) =>
    ["started", "called", "gateway", "places", "next"].indexOf(reasonOf(r));
  return (
    rank(a) - rank(b) ||
    (b.callers?.length ?? 0) - (a.callers?.length ?? 0) ||
    Number(!!b.gateway) - Number(!!a.gateway) ||
    a.index - b.index
  );
}

/** The queue's reason for a repo, in words, for `atticus next`. */
export function queueWhy(r: QueueRepo): string {
  const callers = r.callers ?? [];
  const named =
    callers.length > 3
      ? `${callers.slice(0, 3).join(", ")} and ${callers.length - 3} more`
      : callers.join(", ");
  switch (reasonOf(r)) {
    case "started":
      return "Its read is under way: finish it first.";
    case "called":
      return `${callers.length} read ${callers.length === 1 ? "repo calls" : "repos call"} it (${named})${r.gateway ? ", and it is a gateway" : ""}: read it next and ${callers.length === 1 ? "that link lands" : "those links land"}.`;
    case "gateway":
      return "It is a gateway (its manifest type): the calls through it join once it is read, so it goes before its callers.";
    case "places":
      return "It is a deploy or config repo (its manifest type): its Routes and values say where other repos are reached, so their links land once it is read.";
    default:
      return "Nothing read yet calls it: in the manifests' order.";
  }
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!;

/**
 * The read repos whose calls wait on each repo of `waiting`, from the estate join over the facts
 * on file (verified or not: this ranks the queue, it writes nothing).
 */
export function callersOf(
  op: OrgPack,
  read: readonly { repo: string; facts: readonly Fact[] }[],
  waiting: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  if (!read.length || !waiting.length) return new Map();
  const manifests = estateRepos(op);
  // A join target is a repo id or a component id, as the join writes it (factIdPart).
  const byTarget = new Map<string, string>();
  for (const id of waiting) {
    const m = manifests.find((r) => r.id === id);
    byTarget.set(factIdPart(id), id);
    if (m?.component) byTarget.set(factIdPart(m.component), id);
    for (const mod of m?.modules ?? []) byTarget.set(factIdPart(mod.component), id);
  }
  const repos = joinReposOf(op, [
    ...read,
    ...waiting
      .filter((id) => !read.some((r) => r.repo === id))
      .map((repo) => ({ repo, facts: [] })),
  ]);
  const join = joinFacts({ repos, outside: outsideSystems(op), ...joinConventions(op) });
  for (const m of join.misses) {
    const to = byTarget.get(factIdPart(m.target));
    if (!to || to === m.call.repo) continue;
    out.set(to, (out.get(to) ?? new Set()).add(m.call.repo));
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * The queue over `waiting` (the repos not mapped yet, in the manifests' order): which have a read
 * under way is the caller's to say. Problems (an org pack or facts file that doesn't read) are
 * said and the queue falls back to the manifests' order, never a crash.
 */
export async function onboardingQueue(
  root: string,
  waiting: readonly { repo: string; started?: boolean }[],
): Promise<{ queue: QueueRepo[]; problems: { file: string; message: string }[] }> {
  const problems: { file: string; message: string }[] = [];
  let op: OrgPack | undefined;
  try {
    op = await loadOrgPack(orgPackDirOf(root));
  } catch (e) {
    problems.push({ file: "org-pack", message: firstLine(e) });
  }
  const manifests = op ? estateRepos(op) : [];
  const ids = waiting.map((w) => w.repo);
  let callers = new Map<string, string[]>();
  if (op) {
    // Every repo's facts on file: the mapped repos' and those of reads under way.
    const read: { repo: string; facts: Fact[] }[] = [];
    for (const m of manifests) {
      const text = await readFile(join(factsDirOf(root), `${m.id}.jsonl`), "utf8").catch(
        () => undefined,
      );
      if (!text?.trim()) continue;
      const p = parseFacts(text);
      if (p.ok) read.push({ repo: m.id, facts: p.facts });
    }
    try {
      callers = callersOf(op, read, ids);
    } catch (e) {
      problems.push({
        file: "facts",
        message: `the join couldn't rank the queue: ${firstLine(e)}`,
      });
    }
  }
  const queue = waiting
    .map((w, index) => {
      const m = manifests.find((r) => r.id === w.repo);
      const by = callers.get(w.repo) ?? [];
      return {
        repo: w.repo,
        index,
        ...(w.started ? { started: true } : {}),
        ...(m && /^gateway(-|$)/.test(m.type) ? { gateway: true } : {}),
        ...(m && /^(deploy|config)(-|$)/.test(m.type) ? { places: true } : {}),
        ...(by.length ? { callers: by } : {}),
      };
    })
    .sort(queueOrder);
  return { queue, problems };
}
