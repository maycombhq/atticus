import { join } from "node:path";
import {
  assistantNames,
  changeFolder,
  changeStore,
  loadChangeContext,
  writeFileAtomic,
} from "@maycombhq/changes";
import { Lens, runsDirOf, toCanonicalYaml } from "@maycombhq/core";
import { toRunSummary, type Run } from "@maycombhq/ai";
import {
  leftOut,
  parseLensOutput,
  personaSkipped,
  type Discarded,
  type LensName,
  type LensRun,
} from "./ai.js";
import { checkAbsences, codeSearchFor, type CodeSearch } from "./code.js";
import { draftDocs, DRAFT_DIR, keepLensRecords } from "./critic.js";
import { CriticError } from "./errors.js";
import {
  fingerprint,
  mergeHits,
  readRound,
  readRoundMeta,
  reviewedGates,
  roundsOf,
} from "./findings.js";
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
  const m = /^findings-([a-z0-9-]+)\.yaml$/.exec(request.outputPath);
  // ADR 0203 C: a persona's naysayer rides on the complete question.
  if (m?.[1]?.endsWith("-naysayer")) return "complete";
  const lens = m ? Lens.safeParse(m[1]) : undefined;
  return lens?.success ? lens.data : undefined;
}

export interface WaitingLens {
  lens: string;
  runId: string;
  round: number;
  /** ADR 0203 C: the persona whose lens this is; nothing waits on it. */
  persona?: string;
}

/**
 * ADR 0203 C: the persona lenses of every round at a gate still with the person's assistant,
 * newest round first. Nothing waits on them; an answer that comes is read in (into the gate's
 * newest round, completeLensRun), whatever round it was asked in.
 */
export async function personaLensesOut(
  root: string,
  change: string,
  gate: string,
): Promise<WaitingLens[]> {
  const out: WaitingLens[] = [];
  for (const n of (await roundsOf(root, change, gate)).reverse())
    out.push(
      ...(await waitingLenses(root, change, gate, n, { personas: true })).filter((w) => w.persona),
    );
  return out;
}

/**
 * The AI lenses of a round at a gate that are still with the person's assistant: the newest
 * round, or the round given (a stage waits on its own round, whatever ran at the gate since). A
 * persona lens is never one: nothing waits on it (ADR 0203 C), and its answer is read in when
 * it comes.
 */
export async function waitingLenses(
  root: string,
  change: string,
  gate: string,
  of?: number,
  /** Also the persona lenses still out: to read in an answer that came, never to wait on one. */
  o: { personas?: boolean } = {},
): Promise<WaitingLens[]> {
  const round = of ?? (await roundsOf(root, change, gate)).at(-1);
  if (round === undefined) return [];
  const meta = await readRoundMeta(root, change, gate, round);
  return (meta?.lenses ?? [])
    .filter((l) => l.state === "waiting" && l.runId && (o.personas || !l.persona))
    .map((l) => ({
      lens: l.lens,
      runId: l.runId!,
      round,
      ...(l.persona ? { persona: l.persona } : {}),
    }));
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
    ...(entry.lens !== lens ? { persona: entry.lens } : {}),
    agent: entry.agent,
    rules: entry.rules,
    artifacts: entry.artifacts,
    runtime: run.runtime,
    summary,
    runId: run.runId,
    ...(entry.promptSha256 ? { promptSha256: entry.promptSha256 } : {}),
  };
  // ADR 0203 C: a persona lens never holds a gate, so the gate may have had a round since it was
  // handed off. Its answer is read into the gate's newest round, where every reader looks, so a
  // late answer is never lost; nobody waited for it.
  const persona = entry.persona ?? (entry.lens !== lens ? entry.lens : undefined);
  const newest = (await roundsOf(root, changeId, gateId)).at(-1) ?? round;
  const into = persona && newest > round ? newest : round;
  const intoMeta =
    into === round ? meta : ((await readRoundMeta(root, changeId, gateId, into)) ?? meta);
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
    const existing = await readRound(root, changeId, gateId, into);
    const prior = (await roundsOf(root, changeId, gateId)).filter((n) => n < into).at(-1);
    // Findings carried from the last reviewed draft (ADR 0115 addendum, 2026-10-25) aren't
    // written twice when the lens raises them again; nor, read into a later round, one that round
    // already has.
    const carriedAi = new Set(
      intoMeta.findings.filter((f) => f.layer === "ai" && f.unchanged).map((f) => f.id),
    );
    findings = await writeHits(root, hits, {
      known: assistantNames(ctx.lifecycle),
      change: changeId,
      gate: gateId,
      round: into,
      now,
      priorRound: prior,
      taken: new Set(existing.findings.map((s) => s.finding.id)),
      skip: new Set(
        existing.findings
          // A persona's hit the round already has (its answer to another round's ask, read in
          // here) is written once: by the hit's identity, its fingerprint (ADR 0203 C).
          .filter(
            (s) =>
              into !== round ||
              carriedAi.has(s.finding.id) ||
              (!!persona && s.finding.persona === persona),
          )
          .map((s) => fingerprint(s.finding)),
      ),
    });
    await keepLensRecords(root, changeId, gateId, round, [
      { lens, prompt: run.request.pack.prompt, answer: run.output },
    ]);
    // An answer that isn't a review (empty, a refusal, prose) is a failed lens, never a clean one.
    outcome = parsed.malformed
      ? { ...base, state: "failed", reason: parsed.malformed }
      : { ...base, state: "ran", ...(out.reason ? { reason: out.reason } : {}) };
  }
  // A persona lens that didn't review is said, never failed: it holds nothing (ADR 0203 C).
  if (persona && outcome.state === "failed")
    outcome = {
      ...outcome,
      state: "skipped",
      reason: personaSkipped(persona, outcome.reason),
    };
  if (into !== round && outcome.state === "ran")
    outcome = {
      ...outcome,
      reason: `answered after round ${into} ran at the ${gateId} gate: its findings are in round ${into}`,
    };

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
  const written = findings.map((f) => ({
    id: f.finding.id,
    layer: f.layer,
    rule: f.finding.rule,
    severity: f.finding.severity,
    ...(f.carried ? { carried: true } : {}),
  }));
  await writeFileAtomic(
    join(metaDir, "round.yaml"),
    toCanonicalYaml(
      {
        ...meta,
        findings: [...meta.findings, ...(into === round ? written : [])],
        rules: { ...meta.rules, ran: ranRules },
        lenses,
        discarded: [...meta.discarded, ...discarded],
      },
      ROUND_LEADING,
    ),
  );
  // The newest round lists the findings read into it.
  if (into !== round && written.length)
    await writeFileAtomic(
      join(folder, "review", gateId, String(into), "meta", "round.yaml"),
      toCanonicalYaml({ ...intoMeta, findings: [...intoMeta.findings, ...written] }, ROUND_LEADING),
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
 * ADR 0185: the lenses of a batched hand-off read in, once its Done has checked each lens's section
 * in that lens's own run. A lens whose run passed and that its round still waits on is read in as
 * `completeLensRun` reads one answered alone; a lens whose section was missing or failed its check
 * stays waiting, to be fixed in the batch or answered alone. Returns what was read in, in order.
 */
export async function completeLensBatch(
  root: string,
  batch: Run,
  result: (runId: string) => Promise<Run>,
  opts: { now?: string; teamPacks?: string[]; codeSearch?: CodeSearch } = {},
): Promise<CompletedLens[]> {
  const out: CompletedLens[] = [];
  for (const p of batch.parts ?? []) {
    const run = await result(p.runId).catch(() => undefined);
    if (run?.state !== "validated" || !lensRunOf(run.request)) continue;
    const found = await roundOf(root, run.request.change, run.runId);
    if (found?.entry.state !== "waiting") continue;
    out.push(await completeLensRun(root, run, opts));
  }
  return out;
}

/**
 * Record a lens of a round as failed without an answer to read: its run is gone (a cleaned
 * runs folder, another machine) or was cancelled. The round then says the lens never reviewed,
 * and the gate stays closed on it rather than waiting for ever or opening. A persona lens is
 * recorded as skipped, with why: it never holds the gate (ADR 0203 C).
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
  // A persona lens is recorded as skipped, with why: it never holds the gate (ADR 0203 C).
  const lenses = meta.lenses.map((l) =>
    l.runId !== runId
      ? l
      : l.persona
        ? { ...l, state: "skipped" as const, reason: personaSkipped(l.persona, reason) }
        : { ...l, state: "failed" as const, reason },
  );
  await writeFileAtomic(
    join(changeFolder(root, change), "review", gate, String(round), "meta", "round.yaml"),
    toCanonicalYaml({ ...meta, lenses }, ROUND_LEADING),
  );
}
