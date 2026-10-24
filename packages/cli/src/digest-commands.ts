import { createAdapters, type Notifier } from "@maycombhq/adapters";
import { loadOrgPack, orgPackDirOf, type ChangeLifecycle } from "@maycombhq/core";
import { changeStore, liveHandoff } from "@maycombhq/changes";
import { readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import type { Output } from "./commands.js";

/**
 * The personal digest (ADR 0048, 0073): your hand-off PRs that came back with changes
 * requested, and blocking findings on changes you are on. Reviews are the Git host's: it tells
 * reviewers about the PRs they are asked to approve, so the digest doesn't repeat it. The digest
 * goes through the notify adapter only when you send it (the click is the approval); with no
 * notify adapter connected it is shown, never queued.
 */

/** "@Pat.Doe" and "pat.doe" are the same handle. */
const norm = (s: string) => s.toLowerCase().replace(/^@/, "");

/** A hand-off of yours that came back with changes requested. */
export interface HandoffToRevise {
  change: string;
  title: string;
  phase: string;
  pr: string;
  openedAt: string;
}

export interface Digest {
  title: string;
  body: string;
  lines: string[];
  revise: HandoffToRevise[];
  blocking: { change: string; open: number }[];
  /** WP7.5: how each change the person watches is doing, one line each. */
  watching: string[];
}

/** What waits on the person: hand-offs to revise, blocking findings on changes they are on. */
export async function buildDigest(root: string, user: string): Promise<Digest> {
  const revise: HandoffToRevise[] = [];
  const blocking: { change: string; open: number }[] = [];
  const changes = await changeStore(root)
    .list()
    .catch(() => [] as ChangeLifecycle[]);
  const me = norm(user);
  for (const c of changes.sort((a, b) => a.id.localeCompare(b.id))) {
    const h = liveHandoff(c);
    if (h?.state === "changes-requested" && norm(h.by) === me)
      revise.push({
        change: c.id,
        title: c.title,
        phase: h.phase,
        pr: h.pr.url,
        openedAt: h.openedAt,
      });
  }
  for (const c of changes.sort((a, b) => a.id.localeCompare(b.id))) {
    if (c.state === "archived") continue;
    const mine =
      norm(c.createdBy) === me ||
      Object.values(c.owners ?? {}).some((hs) => hs.some((h) => norm(h) === me));
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
  if (revise.length) {
    lines.push(`${revise.length} hand-off${revise.length === 1 ? "" : "s"} to revise:`);
    for (const w of revise) lines.push(`- ${w.change} (${w.phase}): ${w.pr}`);
  }
  if (blocking.length) {
    lines.push("Blocking findings on changes you are on:");
    for (const b of blocking) lines.push(`- ${b.change}: ${b.open} open`);
  }
  if (!lines.length) lines.push("Nothing waits on you.");
  // WP7.5: the changes the person watches, though they aren't on them; not counted as waiting.
  const { readMe } = await import("./me-file.js");
  const { watchLine } = await import("./watch-commands.js");
  const watching: string[] = [];
  for (const c of (await readMe(root)).watch) watching.push(await watchLine(root, c));
  if (watching.length) lines.push("Changes you watch:", ...watching.map((w) => `- ${w}`));
  const n = revise.length + blocking.length;
  return {
    title: !n
      ? "Atticus: nothing waits on you"
      : n === 1
        ? "Atticus: 1 thing waits on you"
        : `Atticus: ${n} things wait on you`,
    body: lines.join("\n"),
    lines,
    revise,
    blocking,
    watching,
  };
}

export interface DigestDeps {
  /** Tests inject a notifier; otherwise runtime.yaml's notify adapter. */
  notify?: Notifier;
  now?: string;
}

/**
 * atticus digest [--as <you>] [--channel c] [--send] [--json]. Prints the digest for the
 * person (the Git user unless --as names someone); --send posts it through the notify adapter,
 * with the person's own approval.
 */
export async function digestCommand(
  root: string,
  o: { as?: string; channel?: string; send?: boolean; json?: boolean },
  io: Output,
  deps: DigestDeps = {},
): Promise<number> {
  if (!o.as) {
    io.err("Usage: atticus digest [--as <you>] [--channel <c>] [--send] [--json]");
    return 2;
  }
  const d = await buildDigest(root, o.as);
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
