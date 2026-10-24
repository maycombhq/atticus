import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAdapters, fileStepStore, type Approval, type GitHost } from "@maycombhq/adapters";
import { changesRelOf, handoffBranch, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import {
  ChangeError,
  archiveChange,
  changeFootprint,
  changeReport,
  changeStore,
  detectConflicts,
  handoff,
  loadChangeContext,
  newChange,
  returnToPo,
  syncHandoff,
  type HandoffPublisher,
  type Reason,
} from "@maycombhq/changes";
import {
  baseClonePath,
  createWorkspace,
  isInPlace,
  loadRepos,
  type GitRunner,
} from "@maycombhq/workspace";
import { gateStatus, reviewedGates } from "@maycombhq/naysayer";
import type { Output } from "./commands.js";
import { statusLine } from "./critic-commands.js";
import { table } from "./index-commands.js";
import { scanCommand } from "./scan-commands.js";

/**
 * atticus change …: the change lifecycle. A gate is approved when its hand-off PR merges
 * (ADR 0073). Every write to the Git host (opening, merging or closing a hand-off PR) needs the
 * person's explicit --approve; without it the command says what it would do and sends nothing.
 * The person is the metarepo's Git user unless --by names someone.
 */

/** Things tests (and the local API) inject instead of what runtime.yaml configures. */
export interface ChangeDeps {
  gitHost?: GitHost;
  publisher?: HandoffPublisher;
  /** ISO timestamp used for every time this command records. */
  now?: string;
  /** Git for updating base clones after archive. */
  git?: GitRunner;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function printReasons(io: Output, reasons: Reason[]) {
  for (const r of reasons) io.err(`  - ${r.message}`);
}

/** Map a lifecycle error to its exit code: 2 for usage, 1 for everything else. */
function fail(io: Output, e: unknown): number {
  if (e instanceof ChangeError) {
    io.err(e.message);
    printReasons(io, e.reasons);
    return e.code === "invalid" ? 2 : 1;
  }
  if (e instanceof Error && e.name === "AdapterError") {
    io.err(e.message);
    return 1;
  }
  throw e;
}

async function gitHostFor(
  root: string,
  deps: ChangeDeps,
  io: Output,
): Promise<GitHost | undefined> {
  if (deps.gitHost) return deps.gitHost;
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  // Manual Git hosts (and unreachable live ones) turn PR actions into steps a person records (ADR 0032).
  const gh = createAdapters(
    op.runtime,
    {},
    { store: fileStepStore(root), root, procedures: op.procedures },
  ).gitHost;
  if (!gh) io.err("No Git host is configured. Set adapters.gitHost in org-pack/runtime.yaml.");
  return gh;
}

const approvalOf = (by: string, at: string, ref: string): Approval => ({ by, at, ref });

/** Parse --owner role=a,b (repeatable) into owners by role. */
export function parseOwners(values: string[]): Record<string, string[]> | string {
  const out: Record<string, string[]> = {};
  for (const v of values) {
    const m = /^([a-z0-9][a-z0-9._-]*)=(.+)$/.exec(v.trim());
    if (!m) return `--owner takes role=person[,person], for example architect=ari; got "${v}"`;
    out[m[1]!] = [
      ...(out[m[1]!] ?? []),
      ...m[2]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ];
  }
  return out;
}

/** atticus change new "<title>" --type <type> [--template t] [--id x] [--owner role=a,b] [--system s] [--by <you>] */
export async function changeNew(
  root: string,
  o: {
    title?: string;
    type?: string;
    template?: string;
    id?: string;
    by?: string;
    owners?: string[];
    systems?: string[];
  },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.title || !o.type || !o.by) {
    io.err(
      'Usage: atticus change new "<title>" --type <change type> [--by <you>] [--template <id>]',
    );
    // The types this metarepo has, so nobody has to open change-types.yaml to pick one (ADR 0119).
    if (!o.type) {
      try {
        const op = await loadOrgPack(join(orgPackDirOf(root)));
        if (op.changeTypes.types.length) {
          io.err("The change types here:");
          for (const t of op.changeTypes.types) io.err(`  ${t.id}  ${t.name}`);
        }
      } catch {
        // No org pack here: the usage says enough.
      }
    }
    return 2;
  }
  const owners = parseOwners(o.owners ?? []);
  if (typeof owners === "string") {
    io.err(owners);
    return 2;
  }
  try {
    const c = await newChange(root, {
      title: o.title,
      type: o.type,
      by: o.by,
      owners,
      ...(o.template ? { template: o.template } : {}),
      ...(o.id ? { id: o.id } : {}),
      ...(o.systems ? { systems: o.systems } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    io.out(`Created ${c.id} (${c.type}, from the ${c.template} template). It is in ${c.state}.`);
    io.out(`Write the brief: ${changesRelOf(root)}/${c.id}/brief.md`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus change status <id>: state, next step, what blocks it, risk, the hand-off PR and test kinds. */
export async function changeStatus(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  let r;
  try {
    r = await changeReport(root, id);
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
  for (const p of r.problems) io.err(p);
  const critic = await usedUpGates(root, r.change.id);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          id: r.change.id,
          state: r.state,
          phase: r.phase,
          next: r.next,
          nextStep: r.nextStep,
          reasons: r.reasons,
          risk: r.risk,
          tests: r.tests,
          privacy: r.privacy,
          handoff: r.handoff,
          footprint: r.footprint,
          ...(critic.length ? { critic } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(`${r.change.id}: ${r.change.title} (${r.change.type})`);
  io.out(`State: ${r.state}`);
  io.out(`Next: ${r.nextStep}`);
  io.out(
    `Risk: ${r.risk.level} (${r.risk.score})${r.risk.factors.length ? ": " : ""}${r.risk.factors
      .map((f) => `${f.detail} +${f.points}`)
      .join("; ")}`,
  );
  if (r.phase)
    io.out(
      r.handoff
        ? r.handoff.state === "changes-requested"
          ? `Hand-off: PR #${r.handoff.pr.number} has changes requested (${r.handoff.pr.url}); update the artifacts and hand off again.`
          : `Hand-off: merge PR #${r.handoff.pr.number} to approve the ${r.phase} gate (${r.handoff.pr.url}).`
        : `Hand-off: no PR yet; atticus change handoff ${r.change.id} --approve opens it, and merging it approves the ${r.phase} gate.`,
    );
  io.out(`Tests: ${r.tests.required.length ? r.tests.required.join(", ") : "none listed"}`);
  if (r.tests.note) io.out(`  (${r.tests.note})`);
  io.out(
    r.privacy.touched
      ? `Privacy: touches personal data (${r.privacy.records.map((x) => x.id).join(", ")}); review it with the ${r.privacy.phase} hand-off.`
      : "Privacy: no personal data touched.",
  );
  if (r.reasons.length > 0) {
    io.out("Blocked by:");
    for (const x of r.reasons) io.out(`  - ${x.message}`);
  }
  // A gate whose critic rounds are used up: what a person does next, in the critic's words.
  for (const line of critic) io.out(`Critic: ${line}`);
  return 0;
}

/** The status lines of the change's gates whose critic rounds are used up (ADR 0115 addendum). */
async function usedUpGates(root: string, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const g of await reviewedGates(root, id).catch(() => [] as string[])) {
    const s = await gateStatus(root, id, g).catch(() => undefined);
    if (s && (s.humanDecides || s.checkRound)) out.push(statusLine(s));
  }
  return out;
}

/**
 * atticus change handoff <id> [--approve] [--by <you>] [--repo <metarepo>] [--base <branch>].
 * Without --approve it checks the phase is ready and says which PR it would open; nothing is sent.
 */
export async function changeHandoff(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; repo?: string; base?: string },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by) {
    io.err("Say who is handing off: set your Git user (git config user.name), or pass --by <you>.");
    return 2;
  }
  if (!o.approve) return handoffPreview(root, id, o.by, io);
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  try {
    const c = await changeStore(root).read(id);
    const phase = c.state === "release-ready" ? "release" : c.state;
    const ref = /^(define|design|plan|build|qa|release)$/.test(phase)
      ? handoffBranch(id, phase)
      : `change/${id}`;
    const h = await handoff(root, id, {
      gitHost,
      by: o.by,
      approval: approvalOf(o.by, now, ref),
      now,
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.base ? { base: o.base } : {}),
      ...(deps.publisher ? { publisher: deps.publisher } : {}),
      // WP7.4: the PR reviews itself: the change as a picture, its estimate, its open findings.
      review: await (await import("./handoff-review.js")).handoffReview(root, id),
    });
    io.out(`Hand-off PR #${h.pr.number} (${h.branch}) is open: ${h.pr.url}`);
    io.out(
      `Reviewers: ${h.reviewers.length ? h.reviewers.map((r) => `@${r}`).join(", ") : "none named"}`,
    );
    io.out(`Merging it approves the gate; the Git host's own rules decide who may approve it.`);
    return 0;
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/** What `change handoff` would do, without --approve: nothing goes to the Git host. */
async function handoffPreview(root: string, id: string, by: string, io: Output): Promise<number> {
  let r;
  try {
    r = await changeReport(root, id);
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
  if (!r.phase) {
    io.err(`${id} is ${r.state}; there is nothing to hand off.`);
    return 1;
  }
  if (r.blockers.length) {
    io.err(`${id} isn't ready to hand off ${r.phase}:`);
    printReasons(io, r.blockers);
    return 1;
  }
  const open = r.handoff && r.handoff.phase === r.phase;
  io.out(
    open
      ? `Would update hand-off PR #${r.handoff!.pr.number} (${r.handoff!.pr.url}) with the ${r.phase} files, as ${by}.`
      : `Would open the ${r.phase} hand-off PR ${handoffBranch(id, r.phase)} with the phase's files, as ${by}.`,
  );
  io.out(
    `Nothing was sent. To do it: atticus change handoff ${id} --approve. Merging the PR approves the gate.`,
  );
  return 0;
}

/**
 * atticus change sync <id> [--approve] [--by <you>] [--repo <metarepo>]: read the PR and record
 * what happened on the Git host. A merged PR moves the change on; with --approve, a PR that is
 * approved and meets the host's rules is merged as the person.
 */
export async function changeSync(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; repo?: string },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  try {
    const r = await syncHandoff(root, id, {
      gitHost,
      now,
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.approve && o.by ? { approval: approvalOf(o.by, now, `${id}#merge`) } : {}),
    });
    if (r.merged) {
      io.out(`PR #${r.handoff.pr.number} merged. ${id} is now ${r.state}.`);
      return 0;
    }
    if (r.ready) {
      io.out(
        `PR #${r.handoff.pr.number} is approved and the Git host's rules are met. Merge it on the Git host, or run atticus change sync ${id} --approve to merge it as you.`,
      );
      return 1;
    }
    io.err(`PR #${r.handoff.pr.number} can't merge yet:`);
    printReasons(io, r.reasons);
    return 1;
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/**
 * atticus change return <id> --reason "<why>" [--approve] [--by <you>]: close the hand-off PR
 * and return the change to the product owner. Without --approve it says what it would do.
 */
export async function changeReturn(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; reason?: string; repo?: string },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by || !o.reason) {
    io.err('Usage: atticus change return <id> --reason "<why>" --approve [--by <you>]');
    return 2;
  }
  if (!o.approve) {
    try {
      const r = await changeReport(root, id);
      if (!r.handoff) {
        io.err(`${id} has no open hand-off PR to return.`);
        return 1;
      }
      io.out(
        `Would comment on PR #${r.handoff.pr.number} (${r.handoff.pr.url}) and close it, and return ${id} to the product owner, as ${o.by}.`,
      );
      io.out(`Nothing was sent. To do it: atticus change return ${id} --reason "..." --approve.`);
      return 0;
    } catch (e) {
      if (e instanceof Error && e.name === "ChangeFileError") {
        io.err(e.message);
        return 1;
      }
      return fail(io, e);
    }
  }
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  try {
    const r = await returnToPo(root, id, {
      gitHost,
      by: o.by,
      reason: o.reason,
      approval: approvalOf(o.by, now, `${id}#return`),
      now,
      ...(o.repo ? { repo: o.repo } : {}),
    });
    io.out(
      r.closedOnHost
        ? `Returned ${id} to the product owner and closed PR #${r.handoff.pr.number}.`
        : `Returned ${id} to the product owner. Close PR #${r.handoff.pr.number} on the Git host by hand; this Git host adapter can't close pull requests.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/** atticus change archive <id> [--by <you>]: archive a released change. */
/**
 * After archive, the released code is the truth: the change's repos are brought up to date
 * where their base clones are here (in-place repos are already current) and the estate is
 * rescanned, so the catalog shows what was built. When none of them is here, the exact
 * commands to run are printed instead. Exit 1 only when the rescan itself had problems.
 */
async function rescanAfterArchive(
  root: string,
  id: string,
  io: Output,
  deps: ChangeDeps,
): Promise<number> {
  const ctx = await loadChangeContext(root);
  const change = await changeStore(root).read(id);
  const fp = await changeFootprint(ctx, change);
  const all = await loadRepos(root);
  const manifest = new Map(all.map((r) => [r.id, r]));
  // Repos the footprint names, and the manifest's repos for its components and systems (the
  // catalog may not say which repo builds a component yet).
  const wanted = [
    ...new Set([
      ...fp.repos,
      ...all
        .filter(
          (r) =>
            fp.components.includes(r.component ?? r.id) ||
            (r.system !== undefined && fp.systems.includes(r.system)),
        )
        .map((r) => r.id),
    ]),
  ].sort();
  const here = wanted.filter((r) => {
    const m = manifest.get(r);
    return !!m && (isInPlace(m.url) || existsSync(baseClonePath(root, r)));
  });
  const away = wanted.filter((r) => !here.includes(r));
  const command = (ids: string[]) =>
    `atticus workspace sync --repos ${ids.join(",")} && atticus scan`;
  if (wanted.length === 0) {
    io.out("The change names no repos; run atticus scan to refresh the catalog.");
    return 0;
  }
  if (here.length === 0) {
    io.out(
      `The change's repos aren't in base clones here, so the catalog wasn't rescanned. Run: ${command(away)}`,
    );
    return 0;
  }
  const clones = here.map((r) => manifest.get(r)!).filter((m) => !isInPlace(m.url));
  if (clones.length) {
    const synced = await createWorkspace(root, deps.git).sync(clones);
    for (const s of synced.filter((x) => x.action === "failed" || x.action === "skipped"))
      io.out(
        `Couldn't update the base clone of ${s.id} (${s.reason ?? s.action}); scanning what is there.`,
      );
  }
  io.out(`Rescanning for ${id}'s repos: ${here.join(", ")}.`);
  const code = await scanCommand(root, {}, io);
  if (away.length)
    io.out(`Not in a base clone here: ${away.join(", ")}. To add them, run: ${command(away)}`);
  return code;
}

export async function changeArchive(
  root: string,
  id: string,
  o: { by?: string; rescan?: boolean },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by) {
    io.err("Say who is archiving: set your Git user (git config user.name), or pass --by <you>.");
    return 2;
  }
  try {
    await archiveChange(root, id, { by: o.by, ...(deps.now ? { now: deps.now } : {}) });
    io.out(`Archived ${id}.`);
    if (o.rescan === false) return 0;
    return await rescanAfterArchive(root, id, io, deps);
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/** atticus change list: every change with its type, state and open hand-off. */
export async function changeList(root: string, o: { json?: boolean }, io: Output): Promise<number> {
  const all = await changeStore(root).list();
  if (o.json) {
    io.out(
      JSON.stringify(
        all.map((c) => ({ id: c.id, title: c.title, type: c.type, state: c.state })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (all.length === 0) {
    io.out("No changes yet. Start one with atticus change new.");
    return 0;
  }
  const rows = all.map((c) => {
    const live = c.handoffs.find((h) => h.state === "open" || h.state === "changes-requested");
    return [c.id, c.type, c.state, live ? `#${live.pr.number} ${live.state}` : "", c.title];
  });
  for (const l of table(["ID", "TYPE", "STATE", "HAND-OFF", "TITLE"], rows)) io.out(l);
  return 0;
}

/** atticus change conflicts: open changes touching the same records or repos. Exit 1 when any overlap. */
export async function changeConflicts(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const pairs = await detectConflicts(root);
  if (o.json) {
    io.out(JSON.stringify(pairs, null, 2));
    return pairs.length ? 1 : 0;
  }
  if (pairs.length === 0) {
    io.out("No open changes overlap.");
    return 0;
  }
  for (const p of pairs) {
    const parts = Object.entries(p.overlap)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k} ${v.join(", ")}`);
    io.out(`${p.changes[0]} and ${p.changes[1]} both touch ${parts.join("; ")}`);
  }
  return 1;
}
