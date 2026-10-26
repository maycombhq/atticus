import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import {
  changeFolder,
  changeStore,
  loadChangeContext,
  writeFileAtomic,
  type ChangeContext,
} from "@maycombhq/changes";
import { Finding, FindingAction, gateRoundLimit } from "@maycombhq/core";
import { z } from "zod";
import { CriticError } from "./errors.js";
import {
  checkRoundDue,
  countedRounds,
  fingerprint,
  readRound,
  reviewedGates,
  roundsOf,
  writeFinding,
  type StoredFinding,
} from "./findings.js";
import { applyPatch, PatchError, patchTarget } from "./patch.js";
import {
  assistantClosed,
  assistantNames,
  assistantOf,
  PERSON_CLOSES,
  Proposal,
  proposalWords,
  readProposals,
  writeProposals,
} from "./proposals.js";
import { checkRoundRule } from "./gates.js";
import { parse } from "yaml";

export type Action = z.infer<typeof FindingAction>;

export interface ActOptions {
  /** Who acts: a person's handle. */
  by: string;
  reason?: string;
  /** Edit and apply: the edited patch (a unified diff against the finding's artifact). */
  edit?: string;
  /** Ask: the role or person it goes to (a knowledge gap defaults to its question's owner). */
  askedOf?: string;
  /** Only look in this gate. */
  gate?: string;
  now?: string;
}

export interface ActResult {
  /** The finding as it is now: still open when an assistant only proposed (`proposed`). */
  finding: Finding;
  /**
   * An assistant's not-relevant or fix of a blocking or risk finding, recorded as a proposal that
   * waits on a person (ADR 0115 addendum, 2026-10-25); the finding stays open.
   */
  proposed?: Proposal;
  /** Change-folder-relative path of the finding file. */
  path: string;
  /** The artifact a patch was applied to, if any. */
  patched?: string;
  message: string;
}

/**
 * Find a finding by id in the newest round of a gate. A problem several gates raised under one
 * id is taken from the gate that ran most recently (the later gate in gates.yaml when they ran
 * at the same moment), unless a gate is named. A copy left in an older round is refused only
 * when no gate has the finding in its newest round.
 */
async function locate(
  lifecycle: ChangeContext,
  root: string,
  change: string,
  id: string,
  gate?: string,
) {
  const gates = gate ? [gate] : await reviewedGates(root, change);
  const order = lifecycle.orgPack.gates.gates.map((g) => g.id);
  const current: { hit: StoredFinding; gate: string }[] = [];
  let stale: string | undefined;
  for (const g of gates) {
    const rounds = await roundsOf(root, change, g);
    const newest = rounds.at(-1);
    if (newest === undefined) continue;
    for (const r of [...rounds].reverse()) {
      const { findings } = await readRound(root, change, g, r);
      const hit = findings.find((f) => f.finding.id === id);
      if (!hit) continue;
      if (r === newest) current.push({ hit, gate: g });
      else
        stale ??= `Finding ${id} is from round ${r} of the ${g} gate; act on round ${newest}, the newest.`;
      break;
    }
  }
  if (current.length === 0) {
    if (stale) throw new CriticError("refused", stale);
    return undefined;
  }
  const rank = (g: string) => (order.includes(g) ? order.indexOf(g) : order.length);
  current.sort(
    (a, b) =>
      b.hit.finding.createdAt.localeCompare(a.hit.finding.createdAt) ||
      rank(b.gate) - rank(a.gate) ||
      a.gate.localeCompare(b.gate),
  );
  return current[0]!.hit;
}

/**
 * Act on a finding: Apply, Edit and apply, Not relevant (with a reason), Waive (blocking only,
 * with a reason, never a constitution finding) or Ask. The rules of C3 are checked before
 * anything is written; Apply and Edit and apply run the finding's patch (or the edited one)
 * against its artifact, which refuses if the artifact changed since the finding was written.
 * Whatever is decided is a change to the finding's file in the metarepo, recorded with the
 * person (`by`); it reaches main through the gate's hand-off PR, whose reviewers see it there
 * (ADR 0073). Nobody's role is checked.
 */
export async function act(
  root: string,
  changeId: string,
  findingId: string,
  action: Action | string,
  o: ActOptions,
): Promise<ActResult> {
  const a = FindingAction.safeParse(action);
  if (!a.success)
    throw new CriticError(
      "invalid",
      `Unknown action ${action}. Use one of: ${FindingAction.options.join(", ")}.`,
    );
  if (!o.by?.trim()) throw new CriticError("invalid", "Say who is acting (--by).");
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new CriticError("not-found", e.message);
    });
  // The change context is read once for the whole action: it is the slow part.
  const lifecycle = await loadChangeContext(root);
  const found = await locate(lifecycle, root, change.id, findingId, o.gate);
  if (!found)
    throw new CriticError(
      "not-found",
      `No finding ${findingId} in ${change.id}'s newest critic rounds.`,
    );
  const f = found.finding;
  const known = assistantNames(lifecycle);
  const ai = assistantOf(lifecycle, o.by);
  // An assistant's resolution of a blocking or risk finding closed nothing (a file from before
  // the rule): a person may still decide it.
  const reopen = !ai && assistantClosed(f, known);
  if (f.state !== "open" && !reopen)
    throw new CriticError(
      "refused",
      `Finding ${f.id} is already ${f.state} (by ${f.resolution?.by ?? "someone"}).${f.state === "asked" && f.resolution?.reason ? ` ${f.resolution.reason}` : ""}`,
    );
  const gap = f.kind === "knowledge-gap";
  const act = a.data;
  // ADR 0115 addendum (2026-10-25): an assistant only proposes about a blocking or risk finding,
  // and never waives.
  const proposing = !!ai && PERSON_CLOSES.has(f.severity) && act !== "ask";
  if (ai && act === "waive")
    throw new CriticError(
      "refused",
      `${o.by} is an assistant: only a person waives a finding. Propose that ${f.id} is not relevant, with a reason, or fix it and record the fix; a person decides.`,
    );

  // A gap has no fix to apply, only a fact to write in: a person who already wrote it by hand
  // records that with edit-and-apply and a reason, no patch needed.
  if (gap && act === "apply")
    throw new CriticError(
      "refused",
      `${f.id} is a knowledge gap, so there is no fix to apply: the missing fact has to be written in. If you already wrote it into ${f.artifact} by hand, record that with: atticus finding ${change.id} ${f.id} edit-and-apply --reason "<what you wrote>" (no patch needed). Otherwise route the question to its owner: atticus finding ${change.id} ${f.id} ask.`,
    );
  if (gap && act !== "ask" && act !== "edit-and-apply")
    throw new CriticError(
      "refused",
      `${f.id} is a knowledge gap: answer it with Ask (route the question to its owner) or Edit and apply (write the fact in). It can't be ${act === "waive" ? "waived" : act === "apply" ? "applied" : "dismissed"}.`,
    );
  const proposals = await readProposals(root, change.id, f.gate, f.round);
  const waiting = proposals.find((p) => p.finding === f.id);
  // A person taking an assistant's proposal: with no reason of their own, its reason is kept,
  // saying whose it was and who accepted it.
  if (
    !ai &&
    act === "not-relevant" &&
    !o.reason?.trim() &&
    waiting?.claim === "not-relevant" &&
    waiting.reason
  )
    o = {
      ...o,
      reason: `${waiting.reason.trim()} (proposed by ${waiting.by}; accepted by ${o.by})`,
    };
  if (act === "not-relevant" && !o.reason?.trim())
    throw new CriticError("invalid", "Not relevant needs a reason (--reason).");

  if (act === "waive") {
    if (f.severity !== "blocking")
      throw new CriticError(
        "refused",
        `Only blocking findings can be waived; ${f.id} is ${f.severity}. Dismiss it as not relevant instead.`,
      );
    if (f.layer === "constitution")
      throw new CriticError(
        "refused",
        `${f.id} comes from a constitution rule (${f.rule}), which can never be waived. Fix it.`,
      );
    if (!f.waivable)
      throw new CriticError("refused", `Rule ${f.rule} says its findings can't be waived. Fix it.`);
    if (!o.reason?.trim()) throw new CriticError("invalid", "Waive needs a reason (--reason).");
  }
  const askedOf = act === "ask" ? o.askedOf?.trim() || f.question?.owner : undefined;
  if (act === "ask" && !askedOf)
    throw new CriticError("invalid", "Ask needs who it goes to (--asked-of).");

  const state = {
    apply: "applied",
    "edit-and-apply": "applied",
    "not-relevant": "dismissed",
    waive: "waived",
    ask: "asked",
  } as const;
  const { resolution: _was, ...base } = f;
  void _was;
  const next = Finding.safeParse({
    ...base,
    state: state[act],
    resolution: {
      action: act,
      by: o.by,
      at: o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...(o.reason?.trim() ? { reason: o.reason.trim() } : {}),
      ...(askedOf ? { askedOf } : {}),
    },
  });
  if (!next.success)
    throw new CriticError("refused", next.error.issues.map((i) => i.message).join("; "));
  let patched: string | undefined;
  let message: string;
  const patch = act === "edit-and-apply" ? o.edit : act === "apply" ? f.fix.patch : undefined;
  if (act === "edit-and-apply" && !o.edit && !o.reason?.trim())
    throw new CriticError(
      "invalid",
      "Edit and apply needs the edited patch, or a reason saying what you changed by hand.",
    );
  const folder = changeFolder(root, change.id);
  if (patch) {
    const target = patchTarget(patch) ?? f.artifact;
    const safe = normalize(target).split(sep).join("/");
    if (safe !== f.artifact || safe.startsWith("..") || safe.startsWith("/"))
      throw new CriticError(
        "refused",
        `The patch changes ${target}, but the finding is about ${f.artifact}; a patch may only change its own artifact.`,
      );
    // A file a stage renders from its source is written again on the next run: a fix there is
    // lost (a live run, 2026-10-25, fixed a story's .md, not stage/stories-answer.yaml).
    const from = (await renderedFrom(folder)).get(safe);
    if (from) throw new CriticError("refused", renderedRefusal(change.id, safe, from));
    const path = join(changeFolder(root, change.id), f.artifact);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new CriticError(
        "refused",
        `${f.artifact} doesn't exist, so the patch can't be applied.`,
      );
    }
    try {
      await writeFileAtomic(path, applyPatch(text, patch));
    } catch (e) {
      if (e instanceof PatchError)
        throw new CriticError("refused", `The patch doesn't apply: ${e.message}.`);
      throw e;
    }
    patched = f.artifact;
    message = `Applied the fix to ${f.artifact}.`;
  } else if (act === "apply") message = `${f.id} has no patch; marked applied.`;
  else if (act === "edit-and-apply") {
    // The files the person changed, from the stages' write hashes; with none changed, what they
    // did, in their words (W6): no file is named that nobody edited.
    const edited = await editedByPerson(folder);
    // Only rendered files edited: the fix is lost the next time the stage writes them.
    const rendered = await renderedFrom(folder);
    const lost = edited.filter((x) => rendered.has(x));
    if (lost.length && lost.length === edited.length)
      throw new CriticError(
        "refused",
        renderedRefusal(change.id, lost[0]!, rendered.get(lost[0]!)!),
      );
    const said = o.reason?.trim().replace(/[.!?]+$/, "");
    message = edited.length
      ? `Recorded your edit to ${edited.join(", ")}.`
      : said
        ? `Recorded what you did: ${said}.`
        : `Recorded your edit to ${f.artifact}.`;
  } else if (act === "ask")
    message = `Asked ${askedOf}. The gap stops blocking while the question is open.`;
  else if (act === "waive")
    message = `Waived ${f.id}. The waiver, its reason and your name are recorded on the finding; it reaches main with the ${f.gate} hand-off PR, where reviewers see it.`;
  else message = `Dismissed ${f.id} as not relevant.`;

  if (proposing) {
    const proposed = Proposal.parse({
      finding: f.id,
      claim: act === "not-relevant" ? "not-relevant" : "fixed",
      action: act,
      by: o.by,
      at: next.data.resolution!.at,
      ...(o.reason?.trim() ? { reason: o.reason.trim() } : {}),
      fingerprint: fingerprint(f),
    });
    await writeProposals(root, change.id, f.gate, f.round, [
      ...proposals.filter((p) => p.finding !== f.id),
      proposed,
    ]);
    const done = patched ? `Applied the fix to ${patched}. ` : "";
    return {
      finding: f,
      proposed,
      path: found.path,
      ...(patched ? { patched } : {}),
      message: `${done}${f.id} stays open: ${proposalWords(proposed)}. ${
        proposed.claim === "fixed"
          ? "The next critic round checks the fix, and a person closes the finding"
          : "A person closes it"
      } (atticus finding ${change.id} ${f.id} ${proposed.claim === "fixed" ? "apply" : "not-relevant"}, as themselves).`,
    };
  }
  await writeFinding(root, next.data);
  // A person decided: what an assistant proposed about it is answered.
  if (waiting)
    await writeProposals(
      root,
      change.id,
      f.gate,
      f.round,
      proposals.filter((p) => p.finding !== f.id),
    );
  // What comes next: the next critic round checks a fix, unless the gate has none left.
  const after = act === "ask" ? undefined : await afterLimit(lifecycle, root, change.id, next.data);
  if (after) message = `${message} ${after}`;
  else if (act === "apply" || act === "edit-and-apply")
    message =
      patched || act === "edit-and-apply"
        ? `${message.replace(/\.$/, "")}; the next critic round checks it.`
        : `${message} The next critic round checks the fix.`;
  return { finding: next.data, path: found.path, ...(patched ? { patched } : {}), message };
}

/**
 * What comes after a person's decision on a finding (a gap included) when the gate's critic rounds are
 * used up (ADR 0115 addendum): the other blocking findings of the round still to act on, or the
 * one checking round past the limit that reviews what was done. Undefined while rounds are left.
 */
async function afterLimit(
  ctx: ChangeContext,
  root: string,
  change: string,
  f: Finding,
): Promise<string | undefined> {
  const max = gateRoundLimit(ctx.orgPack.gates, f.gate);
  if (max === undefined || (await countedRounds(root, change, f.gate)).length < max)
    return undefined;
  const left = (await readRound(root, change, f.gate, f.round)).findings.filter(
    (x) => x.finding.severity === "blocking" && x.finding.state === "open",
  ).length;
  if (left)
    return `But no critic round is left at the ${f.gate} gate: act on the ${f.severity === "blocking" ? "other " : ""}${left} blocking finding${left === 1 ? "" : "s"} of round ${f.round}; once every one is acted on, ${checkRoundRule(f.round)}.`;
  if ((await checkRoundDue(root, change, f.gate)).length === 0) return undefined;
  return `The ${f.gate} gate has no critic round left, but ${checkRoundRule(f.round)}: run atticus critic ${change} --gate ${f.gate}, or run the change's stage again, to review what was done. If that round finds something blocking, a person decides again.`;
}

/** A file a stage renders: the stage, and the source it is rendered from. */
interface RenderedFrom {
  stage: string;
  source: string;
}

/**
 * The change-folder files a stage renders from its source (ADR 0087 addendum, 2026-10-25): each
 * stage's loop file names its source (`source`) and keeps what it wrote (`written`); a file it
 * wrote that isn't the source, or under it, is rendered, and the next run writes it again. Facts,
 * read off the loop files; a loop file from before `source` was kept names none.
 */
async function renderedFrom(folder: string): Promise<Map<string, RenderedFrom>> {
  const out = new Map<string, RenderedFrom>();
  const stages = await readdir(join(folder, "stage")).catch(() => [] as string[]);
  for (const s of stages.filter((x) => x.endsWith(".yaml")).sort()) {
    let loop: { stage?: unknown; source?: unknown; written?: unknown } | undefined;
    try {
      loop = parse(await readFile(join(folder, "stage", s), "utf8")) as typeof loop;
    } catch {
      continue;
    }
    const source = loop?.source;
    if (typeof source !== "string" || !loop?.written || typeof loop.written !== "object") continue;
    const stage = typeof loop.stage === "string" ? loop.stage : s.replace(/\.yaml$/, "");
    for (const file of Object.keys(loop.written as Record<string, unknown>)) {
      const own = source.endsWith("/") ? file.startsWith(source) : file === source;
      if (!own && !out.has(file)) out.set(file, { stage, source });
    }
  }
  return out;
}

/** The command that runs a stage again, as the stage loop names it. */
const stageRun = (stage: string, change: string) =>
  stage === "stories" ? `atticus plan stories ${change}` : `atticus change ${stage} ${change}`;

/** Why a fix to a rendered file is refused, and where it goes instead. */
function renderedRefusal(change: string, file: string, from: RenderedFrom): string {
  return `${file} is written by the ${from.stage} stage from ${from.source}, so a fix there is lost the next time the stage writes it. Make the fix in ${from.source}, run ${stageRun(from.stage, change)} (it checks your edit as the stage's draft and writes ${file} again), then record it here with edit-and-apply --reason "<what you changed>".`;
}

/**
 * The change-folder files a person changed since a stage wrote them: each stage's loop file
 * (`stage/<stage>.yaml`) keeps the sha-256 of what it wrote (`written`, ADR 0087 addendum), and a
 * file whose hash differs, or is gone, was changed. Facts, read off the files.
 */
async function editedByPerson(folder: string): Promise<string[]> {
  const out = new Set<string>();
  const stages = await readdir(join(folder, "stage")).catch(() => [] as string[]);
  for (const s of stages.filter((x) => x.endsWith(".yaml")).sort()) {
    let written: unknown;
    try {
      written = (parse(await readFile(join(folder, "stage", s), "utf8")) as { written?: unknown })
        ?.written;
    } catch {
      continue;
    }
    if (!written || typeof written !== "object") continue;
    for (const [file, hash] of Object.entries(written as Record<string, unknown>)) {
      const now = await readFile(join(folder, ...file.split("/"))).catch(() => undefined);
      const h = now ? createHash("sha256").update(now).digest("hex") : undefined;
      if (h !== hash) out.add(file);
    }
  }
  return [...out].sort();
}
