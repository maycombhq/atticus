import { join } from "node:path";
import { changeFolder, changeStore, loadChangeContext, writeFileAtomic } from "@maycombhq/changes";
import { Lens, runsDirOf, toCanonicalYaml } from "@maycombhq/core";
import { toRunSummary, type Run } from "@maycombhq/ai";
import { leftOut, parseLensOutput, type Discarded, type LensName, type LensRun } from "./ai.js";
import { checkAbsences, codeSearchFor, type CodeSearch } from "./code.js";
import { draftDocs, DRAFT_DIR } from "./critic.js";
import { CriticError } from "./errors.js";
import { mergeHits, readRound, readRoundMeta, reviewedGates, roundsOf } from "./findings.js";
import { gateStatusOf, type GateStatus } from "./gates.js";
import {
  prepareLayers,
  resolveGate,
  ROUND_LEADING,
  writeHits,
  type CriticFinding,
} from "./round.js";

/**
 * Finishing a critic round whose AI lenses went to the person's assistant (hand-off mode).
 * `runCritic` writes the round with the layer-1 findings and each AI lens `waiting` with its run
 * id; when `atticus handoff done <run>` has the assistant's answer, `completeLensRun` reads it
 * into that round exactly as a model run's answer is read: the same parser, a finding must name
 * a rule the lens was asked to apply and a file it was given and quote what is really on the
 * line it cites, and nothing the defences left out of the lens's pack can be cited.
 */

/**
 * The lens a hand-off run reviews for, when the run is a critic lens's. The answer is a file in
 * the run's own folder, named `findings-<lens>.yaml`.
 */
export function lensRunOf(request: {
  outputPath: string;
  outputIn?: string;
}): LensName | undefined {
  if (request.outputIn !== "run") return undefined;
  const m = /^findings-([a-z-]+)\.yaml$/.exec(request.outputPath);
  const lens = m ? Lens.safeParse(m[1]) : undefined;
  return lens?.success ? lens.data : undefined;
}

export interface WaitingLens {
  lens: string;
  runId: string;
  round: number;
}

/**
 * The AI lenses of a round at a gate that are still with the person's assistant: the newest
 * round, or the round given (a stage waits on its own round, whatever ran at the gate since).
 */
export async function waitingLenses(
  root: string,
  change: string,
  gate: string,
  of?: number,
): Promise<WaitingLens[]> {
  const round = of ?? (await roundsOf(root, change, gate)).at(-1);
  if (round === undefined) return [];
  const meta = await readRoundMeta(root, change, gate, round);
  return (meta?.lenses ?? [])
    .filter((l) => l.state === "waiting" && l.runId)
    .map((l) => ({ lens: l.lens, runId: l.runId!, round }));
}

export interface CompletedLens {
  change: string;
  gate: string;
  round: number;
  /** The lens as the round now records it: ran, or failed with the reason. */
  lens: LensRun;
  /** The findings this lens added to the round. */
  findings: CriticFinding[];
  /** What the lens said that was left out, and why. */
  discarded: Discarded[];
  /** Lenses of the round that are still with the assistant. */
  waiting: WaitingLens[];
  /** The gate's status now, recomputed from the round. */
  status: GateStatus;
}

const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** The round that is waiting for a run: the newest first, at any gate that has been reviewed. */
async function roundOf(root: string, change: string, runId: string, gate?: string) {
  const gates = gate ? [gate] : await reviewedGates(root, change);
  for (const g of gates)
    for (const n of (await roundsOf(root, change, g)).reverse()) {
      const meta = await readRoundMeta(root, change, g, n);
      const entry = meta?.lenses.find((l) => l.runId === runId);
      if (meta && entry) return { gate: g, round: n, meta, entry };
    }
  return undefined;
}

/**
 * Read a finished hand-off lens run into the round that is waiting for it. A run that did not
 * validate marks its lens failed. The gate's status follows: it stays closed while any lens of
 * the round is still with an assistant.
 */
export async function completeLensRun(
  root: string,
  run: Run,
  opts: { now?: string; teamPacks?: string[]; codeSearch?: CodeSearch } = {},
): Promise<CompletedLens> {
  const lens = lensRunOf(run.request);
  if (!lens) throw new CriticError("invalid", `Run ${run.runId} isn't a critic lens review.`);
  const changeId = run.request.change;
  const found = await roundOf(root, changeId, run.runId);
  if (!found)
    throw new CriticError(
      "not-found",
      `No critic round of ${changeId} is waiting for run ${run.runId}.`,
    );
  const { gate: gateId, round, meta, entry } = found;
  if (entry.state === "ran")
    throw new CriticError(
      "refused",
      `The ${lens} lens of round ${round} at the ${gateId} gate has already been read in.`,
    );
  const now = opts.now ?? iso();
  const choice = await resolveGate(root, changeId, gateId);
  const { ctx, applicable } = await prepareLayers(
    root,
    choice,
    meta.createdAt,
    opts.teamPacks ?? [],
  );
  const folder = changeFolder(root, changeId);
  const metaDir = join(folder, "review", gateId, String(round), "meta");

  const summary = toRunSummary(run);
  await writeFileAtomic(
    join(metaDir, "runs", `${run.request.agent.id}.yaml`),
    toCanonicalYaml(summary, ["schemaVersion", "runId"]),
  );

  const base = {
    lens,
    agent: entry.agent,
    rules: entry.rules,
    artifacts: entry.artifacts,
    runtime: run.runtime,
    summary,
    runId: run.runId,
    ...(entry.promptSha256 ? { promptSha256: entry.promptSha256 } : {}),
  };
  let outcome: LensRun;
  let discarded: Discarded[] = [];
  let findings: CriticFinding[] = [];
  if (run.state !== "validated" || run.output === undefined) {
    outcome = {
      ...base,
      state: "failed",
      reason: run.errors.join("; ") || `the run ended ${run.state}`,
    };
  } else {
    const rules = applicable.filter((r) => entry.rules.includes(r.id));
    const out = leftOut(run.request.pack, entry.artifacts);
    const given = entry.artifacts.filter((p) => !out.left.has(p));
    // A stage's draft the lens reviewed (ADR 0115) isn't an artifact: read it as the lens was
    // given it (the copy kept in the run's folder at the hand-off), else from the change folder.
    const drafts = given.filter((p) => !ctx.files.docs.has(p));
    const kept = await draftDocs(join(runsDirOf(root), changeId, run.runId, DRAFT_DIR), drafts);
    const docs = [
      ...given.map((p) => ctx.files.docs.get(p)).filter((d) => d !== undefined),
      ...kept,
      ...(await draftDocs(
        folder,
        drafts.filter((p) => !kept.some((d) => d.path === p)),
      )),
    ];
    const parsed = parseLensOutput(ctx, lens, run.output, rules, docs);
    // A name a finding says is missing, looked up as a fact (W1), as in model mode.
    await checkAbsences(root, ctx.records, parsed.hits, codeSearchFor(opts.codeSearch));
    discarded = parsed.discarded;
    const hits = mergeHits(parsed.hits, ctx.systemOf);
    const existing = await readRound(root, changeId, gateId, round);
    const prior = (await roundsOf(root, changeId, gateId)).filter((n) => n < round).at(-1);
    findings = await writeHits(root, hits, {
      change: changeId,
      gate: gateId,
      round,
      now,
      priorRound: prior,
      taken: new Set(existing.findings.map((s) => s.finding.id)),
    });
    // An answer that isn't a review (empty, a refusal, prose) is a failed lens, never a clean one.
    outcome = parsed.malformed
      ? { ...base, state: "failed", reason: parsed.malformed }
      : { ...base, state: "ran", ...(out.reason ? { reason: out.reason } : {}) };
  }

  // The round records the lens as read in (or failed), its findings and what was discarded.
  const lenses = meta.lenses.map((l) => {
    if (l.runId !== run.runId) return l;
    const { reason: _reason, ...rest } = l;
    void _reason;
    return { ...rest, state: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  });
  const ranRules =
    outcome.state === "ran"
      ? [...new Set([...meta.rules.ran, ...entry.rules])].sort()
      : meta.rules.ran;
  await writeFileAtomic(
    join(metaDir, "round.yaml"),
    toCanonicalYaml(
      {
        ...meta,
        findings: [
          ...meta.findings,
          ...findings.map((f) => ({
            id: f.finding.id,
            layer: f.layer,
            rule: f.finding.rule,
            severity: f.finding.severity,
            ...(f.carried ? { carried: true } : {}),
          })),
        ],
        rules: { ...meta.rules, ran: ranRules },
        lenses,
        discarded: [...meta.discarded, ...discarded],
      },
      ROUND_LEADING,
    ),
  );

  const change = await changeStore(root).read(changeId);
  const lifecycle = await loadChangeContext(root);
  return {
    change: changeId,
    gate: gateId,
    round,
    lens: outcome,
    findings,
    discarded,
    waiting: await waitingLenses(root, changeId, gateId),
    status: await gateStatusOf(root, lifecycle, change, gateId),
  };
}

/**
 * Record a lens of a round as failed without an answer to read: its run is gone (a cleaned
 * runs folder, another machine) or was cancelled. The round then says the lens never reviewed,
 * and the gate stays closed on it rather than waiting for ever or opening.
 */
export async function failLens(
  root: string,
  change: string,
  gate: string,
  round: number,
  runId: string,
  reason: string,
): Promise<void> {
  const meta = await readRoundMeta(root, change, gate, round);
  if (!meta || !meta.lenses.some((l) => l.runId === runId && l.state === "waiting")) return;
  const lenses = meta.lenses.map((l) =>
    l.runId === runId ? { ...l, state: "failed" as const, reason } : l,
  );
  await writeFileAtomic(
    join(changeFolder(root, change), "review", gate, String(round), "meta", "round.yaml"),
    toCanonicalYaml({ ...meta, lenses }, ROUND_LEADING),
  );
}
