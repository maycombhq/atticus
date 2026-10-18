import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { changeFolder, changeStore, loadChangeContext, writeFileAtomic } from "@maycombhq/changes";
import { Finding, FindingAction } from "@maycombhq/core";
import { z } from "zod";
import { CriticError } from "./errors.js";
import { readRound, reviewedGates, roundsOf, writeFinding } from "./findings.js";
import { applyPatch, PatchError, patchTarget } from "./patch.js";

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
  finding: Finding;
  /** Change-folder-relative path of the finding file. */
  path: string;
  /** The artifact a patch was applied to, if any. */
  patched?: string;
  message: string;
}

const bare = (h: string) => h.replace(/^@/, "").toLowerCase();

/** Find a finding by id in the newest round of each gate. */
async function locate(root: string, change: string, id: string, gate?: string) {
  const gates = gate ? [gate] : await reviewedGates(root, change);
  for (const g of gates) {
    const rounds = await roundsOf(root, change, g);
    const newest = rounds.at(-1);
    if (newest === undefined) continue;
    for (const r of [...rounds].reverse()) {
      const { findings } = await readRound(root, change, g, r);
      const hit = findings.find((f) => f.finding.id === id);
      if (!hit) continue;
      if (r !== newest)
        throw new CriticError(
          "refused",
          `Finding ${id} is from round ${r} of the ${g} gate; act on round ${newest}, the newest.`,
        );
      return hit;
    }
  }
  return undefined;
}

/**
 * Act on a finding: Apply, Edit and apply, Not relevant (with a reason), Waive (blocking only,
 * stage owner only, never a constitution finding) or Ask. The rules of C3 are checked before
 * anything is written; Apply and Edit and apply run the finding's patch (or the edited one)
 * against its artifact, which refuses if the artifact changed since the finding was written.
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
  const found = await locate(root, change.id, findingId, o.gate);
  if (!found)
    throw new CriticError(
      "not-found",
      `No finding ${findingId} in ${change.id}'s newest critic rounds.`,
    );
  const f = found.finding;
  if (f.state !== "open")
    throw new CriticError(
      "refused",
      `Finding ${f.id} is already ${f.state} (by ${f.resolution?.by ?? "someone"}).`,
    );
  const gap = f.kind === "knowledge-gap";
  const act = a.data;

  if (gap && act !== "ask" && act !== "edit-and-apply")
    throw new CriticError(
      "refused",
      `${f.id} is a knowledge gap: answer it with Ask (route the question to its owner) or Edit and apply (write the fact in). It can't be ${act === "waive" ? "waived" : act === "apply" ? "applied" : "dismissed"}.`,
    );
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
    const lifecycle = await loadChangeContext(root);
    const gate = lifecycle.orgPack.gates.gates.find((g) => g.id === f.gate);
    const roles = gate?.approvers ?? [];
    const owners = roles.flatMap((r) => change.owners[r] ?? []).map(bare);
    if (!owners.includes(bare(o.by)))
      throw new CriticError(
        "refused",
        `Only the ${f.gate} stage owner can waive: ${roles.join(", ") || "no role"} on this change (${owners.join(", ") || "nobody is named in change.yaml"}). ${o.by} is not.`,
      );
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
  const next = Finding.safeParse({
    ...f,
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
  if (patch) {
    const target = patchTarget(patch) ?? f.artifact;
    const safe = normalize(target).split(sep).join("/");
    if (safe !== f.artifact || safe.startsWith("..") || safe.startsWith("/"))
      throw new CriticError(
        "refused",
        `The patch changes ${target}, but the finding is about ${f.artifact}; a patch may only change its own artifact.`,
      );
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
    message = `Applied the fix to ${f.artifact}; the next critic round checks it.`;
  } else if (act === "apply")
    message = `${f.id} has no patch; marked applied. The next critic round checks the fix.`;
  else if (act === "edit-and-apply")
    message = `Recorded your edit to ${f.artifact}; the next critic round checks it.`;
  else if (act === "ask")
    message = `Asked ${askedOf}. The gap stops blocking while the question is open.`;
  else if (act === "waive")
    message = `Waived ${f.id}. The waiver and its reason are recorded on the finding.`;
  else message = `Dismissed ${f.id} as not relevant.`;

  await writeFinding(root, next.data);
  return { finding: next.data, path: found.path, ...(patched ? { patched } : {}), message };
}
