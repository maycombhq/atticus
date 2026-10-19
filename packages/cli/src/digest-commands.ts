import { createAdapters, type Notifier } from "@maycombhq/adapters";
import { loadOrgPack, orgPackDirOf, type ChangeLifecycle } from "@maycombhq/core";
import { changeStore, liveHandoff } from "@maycombhq/changes";
import { readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import type { Output } from "./commands.js";

/**
 * Approvals waiting and the personal digest (ADR 0048). Approving stays in the Git host: the
 * app lists the hand-off PRs that wait on you and links to them. The digest goes through the
 * notify adapter only when you send it (the click is the approval); with no notify adapter
 * connected it is shown, never queued.
 */

/** "forge/architects", "@Forge-Architects" and "Forge Architects" are the same handle. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whether a handle names the person or one of their groups (org/team handles by their last part). */
export function handleIsMine(
  handle: string,
  user: string,
  groups: readonly string[],
): string | undefined {
  const parts = handle.replace(/^@/, "").split("/");
  const keys = [norm(handle), norm(parts.at(-1)!), norm(parts.join(""))];
  if (keys.includes(norm(user))) return "you";
  return groups.find((g) => keys.includes(norm(g)));
}

export interface WaitingApproval {
  change: string;
  title: string;
  phase: string;
  pr: string;
  /** review: the PR waits on your approval; revise: changes were requested on your hand-off. */
  kind: "review" | "revise";
  because: string;
  openedAt: string;
}

export async function approvalsWaiting(
  root: string,
  user: string,
  groups: readonly string[],
): Promise<WaitingApproval[]> {
  const out: WaitingApproval[] = [];
  const changes = await changeStore(root)
    .list()
    .catch(() => [] as ChangeLifecycle[]);
  for (const c of changes.sort((a, b) => a.id.localeCompare(b.id))) {
    const h = liveHandoff(c);
    if (!h) continue;
    const base = {
      change: c.id,
      title: c.title,
      phase: h.phase,
      pr: h.pr.url,
      openedAt: h.openedAt,
    };
    if (h.state === "changes-requested") {
      if (handleIsMine(h.by, user, groups) === "you")
        out.push({ ...base, kind: "revise", because: "changes were requested on your hand-off" });
      continue;
    }
    if (h.approvals.some((a) => handleIsMine(a.by, user, groups) === "you")) continue;
    for (const r of h.reviewers) {
      const who = handleIsMine(r, user, groups);
      if (!who) continue;
      out.push({
        ...base,
        kind: "review",
        because: who === "you" ? "you are a reviewer" : `${who} is a reviewer`,
      });
      break;
    }
  }
  return out;
}

export interface Digest {
  title: string;
  body: string;
  lines: string[];
  waiting: WaitingApproval[];
  blocking: { change: string; open: number }[];
}

/** What waits on the person: reviews, hand-offs to revise, blocking findings on changes they own. */
export async function buildDigest(
  root: string,
  user: string,
  groups: readonly string[],
): Promise<Digest> {
  const waiting = await approvalsWaiting(root, user, groups);
  const blocking: { change: string; open: number }[] = [];
  const changes = await changeStore(root)
    .list()
    .catch(() => [] as ChangeLifecycle[]);
  for (const c of changes.sort((a, b) => a.id.localeCompare(b.id))) {
    if (c.state === "archived") continue;
    const mine = Object.values(c.owners ?? {}).some((hs) =>
      hs.some((h) => handleIsMine(h, user, groups)),
    );
    if (!mine) continue;
    let open = 0;
    for (const gate of await reviewedGates(root, c.id)) {
      const rounds = await roundsOf(root, c.id, gate);
      if (!rounds.length) continue;
      const round = await readRound(root, c.id, gate, rounds.at(-1)!);
      open += round.findings.filter(
        (f) => f.finding.state === "open" && f.finding.severity === "blocking",
      ).length;
    }
    if (open) blocking.push({ change: c.id, open });
  }
  const lines: string[] = [];
  const reviews = waiting.filter((w) => w.kind === "review");
  const revise = waiting.filter((w) => w.kind === "revise");
  if (reviews.length) {
    lines.push(`${reviews.length} hand-off${reviews.length === 1 ? "" : "s"} wait on your review:`);
    for (const w of reviews) lines.push(`- ${w.change} (${w.phase}): ${w.pr}`);
  }
  if (revise.length) {
    lines.push(`${revise.length} hand-off${revise.length === 1 ? "" : "s"} to revise:`);
    for (const w of revise) lines.push(`- ${w.change} (${w.phase}): ${w.pr}`);
  }
  if (blocking.length) {
    lines.push("Blocking findings on changes you own:");
    for (const b of blocking) lines.push(`- ${b.change}: ${b.open} open`);
  }
  if (!lines.length) lines.push("Nothing waits on you.");
  const n = reviews.length + revise.length + blocking.length;
  return {
    title: !n
      ? "Atticus: nothing waits on you"
      : n === 1
        ? "Atticus: 1 thing waits on you"
        : `Atticus: ${n} things wait on you`,
    body: lines.join("\n"),
    lines,
    waiting,
    blocking,
  };
}

export interface DigestDeps {
  /** Tests inject a notifier; otherwise runtime.yaml's notify adapter. */
  notify?: Notifier;
  now?: string;
}

/**
 * atticus digest --as <you> [--group g]... [--channel c] [--send] [--json]. Prints the digest;
 * --send posts it through the notify adapter, with the person's own approval.
 */
export async function digestCommand(
  root: string,
  o: { as?: string; groups?: string[]; channel?: string; send?: boolean; json?: boolean },
  io: Output,
  deps: DigestDeps = {},
): Promise<number> {
  if (!o.as) {
    io.err("Usage: atticus digest --as <you> [--group <g>]... [--channel <c>] [--send] [--json]");
    return 2;
  }
  const d = await buildDigest(root, o.as, o.groups ?? []);
  let sent: { id: string; channel: string } | undefined;
  let notSent: string | undefined;
  if (o.send) {
    let notify = deps.notify;
    if (!notify) {
      const op = await loadOrgPack(orgPackDirOf(root));
      const cfg = op.runtime.adapters.notify;
      if (!cfg) notSent = "No notify adapter is set in org-pack/runtime.yaml (adapters.notify).";
      else if (cfg.type === "manual")
        notSent = "Notifications are manual here, so the digest is shown instead of sent.";
      else
        try {
          notify = createAdapters({ adapters: { notify: cfg } }).notify;
        } catch (e) {
          notSent = (e as Error).message;
        }
    }
    if (notify) {
      const channel = o.channel ?? `@${o.as}`;
      try {
        const r = await notify.send(
          { channel, title: d.title, body: d.body, mentions: [o.as] },
          {
            by: o.as,
            at: deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            ref: `digest:${o.as}`,
          },
        );
        sent = { id: r.id, channel };
      } catch (e) {
        notSent = `The notify adapter refused: ${(e as Error).message}`;
      }
    }
  }
  if (o.json)
    io.out(
      JSON.stringify({ ...d, ...(sent ? { sent } : {}), ...(notSent ? { notSent } : {}) }, null, 2),
    );
  else {
    io.out(d.title);
    for (const l of d.lines) io.out(l);
    if (sent) io.out(`Sent to ${sent.channel} (${sent.id}).`);
    if (notSent) io.err(notSent);
  }
  return o.send && !sent ? 1 : 0;
}
