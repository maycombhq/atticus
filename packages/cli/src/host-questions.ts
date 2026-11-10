import { stat } from "node:fs/promises";
import {
  HOSTS_NONE,
  HOSTS_OUTSIDE_INTERNAL,
  HOSTS_OUTSIDE_VENDOR,
  HOSTS_STEP,
  hostMatches,
  hostOfQuestion,
  listQuestions,
  raiseQuestions,
  retireQuestion,
  writeQuestion,
  type CatalogRecord,
  type Question,
} from "@maycombhq/core";
import { gatewayHostFix, hostQuestionDrafts, unknownHosts } from "@maycombhq/scanner";
import { fsRepo } from "@maycombhq/sdk";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";

/**
 * Hosts asked, not hand-written (ADR 0088): after a scan, and in atticus estate join, each host
 * the estate's calls name that no repo lists under `hosts` is asked as a question file (ADR
 * 0078). The answer (atticus questions answer) writes the host into the repo's hosts; a host
 * asked before, answered or not, isn't asked again.
 */

export const HOSTS_RERUN = "atticus scan";

export interface HostQuestions {
  /** Asked now. */
  raised: Question[];
  /**
   * Open questions asked before beta.10, re-asked with the same id and evidence now that a hosts
   * question offers an outside system (O1).
   */
  reasked: Question[];
  /** Asked before and still open. */
  open: Question[];
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** Ask which repo answers on each host no repo lists; the lines to print say how to answer. */
export async function askHosts(
  root: string,
  records: readonly CatalogRecord[],
  o: {
    command: string;
    now?: Date;
    /** The command that reads the answer; default atticus scan. */ rerun?: string;
    /** App-only audit: ask only about the calls of these repos (the ones the assistant read). */
    only?: ReadonlySet<string>;
  },
): Promise<HostQuestions & { lines: string[] }> {
  const repos = await loadRepos(root).catch(() => []);
  const dirs = new Map<string, string>();
  for (const r of repos) {
    const dir = baseClonePath(root, r.id);
    if (await isDir(dir)) dirs.set(r.id, dir);
  }
  const asks = await unknownHosts({
    records,
    repos,
    handle: (id) => (dirs.has(id) ? fsRepo(id, dirs.get(id)!, "0".repeat(40)) : undefined),
  });
  const before = (await listQuestions(root, { step: HOSTS_STEP })).questions;
  const asked = new Set(before.map((q) => hostOfQuestion(q)));
  const raised: Question[] = [];
  const at = (o.now ?? new Date()).toISOString();
  const reasked: Question[] = [];
  const OUTSIDE = new Set([HOSTS_OUTSIDE_INTERNAL, HOSTS_OUTSIDE_VENDOR]);
  // Beta.12: a host whose calls reach a gateway's routes, by path: said once, with the fix.
  const gateway = new Map<string, string>();
  for (const { repo, draft, byPath } of hostQuestionDrafts(
    o.only ? asks.filter((a) => a.calls.some((c) => o.only!.has(c.repo))) : asks,
  )) {
    const host = hostOfQuestion(draft);
    if (byPath?.length && host) gateway.set(host, gatewayHostFix(host, byPath));
    if (asked.has(hostOfQuestion(draft))) {
      // O1: a question asked before the outside-system options were offered gains them, while
      // it is open: the same id, evidence and options it had, the new ones before "None of
      // these", so a number someone read still names the same option. An answer is never touched.
      const old = before.find((q) => hostOfQuestion(q) === hostOfQuestion(draft));
      if (!old || old.state !== "open" || old.options.some((x) => OUTSIDE.has(x.label))) continue;
      const add = draft.options.filter((x) => OUTSIDE.has(x.label));
      const none = old.options.findIndex((x) => x.label === HOSTS_NONE);
      const at = none < 0 ? old.options.length : none;
      const next = {
        ...old,
        options: [...old.options.slice(0, at), ...add, ...old.options.slice(at)],
      };
      await writeQuestion(root, next);
      reasked.push(next);
      continue;
    }
    const r = await raiseQuestions(root, [draft], {
      step: HOSTS_STEP,
      repo,
      command: o.command,
      rerun: o.rerun ?? HOSTS_RERUN,
      at,
    });
    raised.push(...r.raised);
  }
  const hosts = new Set(asks.map((a) => a.host));
  const open = before
    .map((q) => reasked.find((x) => x.id === q.id) ?? q)
    .filter((q) => q.state === "open" && hosts.has(hostOfQuestion(q)!));
  const lines: string[] = [];
  // A host a person has since written into the manifest by hand (on a shared host, on every repo
  // that answers there) is answered by the manifest: its open question retires, saying which.
  for (const q of before) {
    const host = hostOfQuestion(q);
    if (q.state !== "open" || !host || hosts.has(host)) continue;
    // Beta.24 review: a "host" read out of a build token (`@targetUrl@` read as `targeturl@`) is
    // none: the join asks about the token's calls instead, and an answer here would write it into
    // the manifest.
    if (/[@{}$]/.test(host)) {
      const why = `${host} was read from a token in a call's URL (a build or deploy step sets it), not a host: the join asks about those calls now`;
      await retireQuestion(root, q.id, { why, at });
      lines.push(`Retired ${q.id} (${q.question}): ${why}.`);
      continue;
    }
    const [name, port] = host.split(/:(?=\d+$)/);
    const listing = repos
      .filter((r) =>
        [...r.hosts, ...r.modules.flatMap((m) => m.hosts)].some((p) =>
          hostMatches(p, name!, port ? Number(port) : undefined),
        ),
      )
      .map((r) => r.id);
    if (!listing.length) continue;
    const why = `${listing.join(", ")} ${listing.length === 1 ? "lists" : "list"} ${host} under hosts in repos.manifest.yaml`;
    await retireQuestion(root, q.id, { why, at });
    lines.push(`Retired ${q.id} (${q.question}): ${why}.`);
  }
  for (const q of raised)
    lines.push(
      gateway.has(hostOfQuestion(q)!)
        ? `Calls to ${hostOfQuestion(q)} join no repo: no repo lists it under hosts. Asked ${q.id}: ${q.question} ${gateway.get(hostOfQuestion(q)!)}. If one repo alone answers on it, answer: atticus questions answer ${q.id} --option <n> (1 is ${q.options[0]!.label}).`
        : `Calls to ${hostOfQuestion(q)} join no repo: no repo lists it under hosts. Asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n> (1 is ${q.options[0]!.label}). If several repos answer on it (a shared gateway or platform host), don't pick one: list it under hosts on each of them in repos.manifest.yaml (with each one's basePath where the path tells them apart), and the question retires itself. If a system outside the estate answers on it, pick an outside system (another team's or a vendor's): it goes into the profile with the host as its alias.`,
    );
  for (const q of reasked)
    lines.push(
      `Re-asked ${q.id} (${q.question}): it now offers an outside system, another team's or a vendor's, for a host no repo of the estate answers on.`,
    );
  for (const q of open)
    lines.push(
      `Still open: ${q.question}${gateway.has(hostOfQuestion(q)!) ? ` ${gateway.get(hostOfQuestion(q)!)}.` : ""} Answer it: atticus questions answer ${q.id} --option <n>, then ${o.rerun ?? HOSTS_RERUN}.`,
    );
  return { raised, reasked, open, lines };
}
