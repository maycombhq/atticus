import { stat } from "node:fs/promises";
import {
  HOSTS_STEP,
  hostMatches,
  hostOfQuestion,
  listQuestions,
  raiseQuestions,
  retireQuestion,
  type CatalogRecord,
  type Question,
} from "@maycombhq/core";
import { hostQuestionDrafts, unknownHosts } from "@maycombhq/scanner";
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
  for (const { repo, draft } of hostQuestionDrafts(asks)) {
    if (asked.has(hostOfQuestion(draft))) continue;
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
  const open = before.filter((q) => q.state === "open" && hosts.has(hostOfQuestion(q)!));
  const lines: string[] = [];
  // A host a person has since written into the manifest by hand (on a shared host, on every repo
  // that answers there) is answered by the manifest: its open question retires, saying which.
  for (const q of before) {
    const host = hostOfQuestion(q);
    if (q.state !== "open" || !host || hosts.has(host)) continue;
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
      `Calls to ${hostOfQuestion(q)} join no repo: no repo lists it under hosts. Asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n> (1 is ${q.options[0]!.label}). If several repos answer on it (a shared gateway or platform host), don't pick one: list it under hosts on each of them in repos.manifest.yaml (with each one's basePath where the path tells them apart), and the question retires itself.`,
    );
  for (const q of open)
    lines.push(
      `Still open: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${o.rerun ?? HOSTS_RERUN}.`,
    );
  return { raised, open, lines };
}
