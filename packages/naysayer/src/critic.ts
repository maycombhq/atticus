import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import {
  fileJudgments,
  judgmentKey,
  Lens,
  runsDirOf,
  toCanonicalYaml,
  type JudgmentStore,
} from "@maycombhq/core";
import {
  PERSONAL_DATA_SPEC,
  settle,
  type AiRuntime,
  type QuarantineItem,
  type SourceInput,
} from "@maycombhq/ai";
import { personalItems } from "./checks/data.js";
import { writeQuarantineItems } from "./defences.js";
import { runLenses, type Discarded, type LensName, type LensRun } from "./ai.js";
import { parseDoc, type Doc } from "./doc.js";
import { artifactOf } from "./artifacts.js";
import type { CodeSearch } from "./code.js";
import { checkRegistry } from "./checks/index.js";
import { CriticError } from "./errors.js";
import {
  checkRoundState,
  countedRounds,
  markNeedHit,
  mergeHits,
  roundsOf,
  type RuledHit,
} from "./findings.js";
import { checkRoundRule, gateStatusOf, maxRoundsOf, type GateStatus } from "./gates.js";
import type { DeterministicCheckDef } from "./hits.js";
import { criticModel, type ModelChoice } from "./model.js";
import { evaluateNeeds } from "./needs.js";
import type { RefusedPack } from "./rules.js";
import {
  prepareLayers,
  resolveGate,
  ROUND_LEADING,
  writeHits,
  type CriticFinding,
} from "./round.js";

export { CONSTITUTION_FILE_LABEL, type CriticFinding } from "./round.js";

export interface RunCriticOptions {
  /** Gate id from gates.yaml. Default: the gate of the change's current phase. */
  gate?: string;
  /** Lenses whose findings are written. Layer 1 always runs whole, to decide what reaches layer 2. */
  lenses?: LensName[];
  /**
   * The AI runtime for layer 2 (mock or replay in tests), and for the judgments the checks read
   * (ADR 0117 addendum) when it calls a model directly. Without it, only layer 1 runs, and what
   * no one has judged is asked of a person.
   */
  runtime?: AiRuntime;
  /** Where judgments are kept and read. Default: the metarepo's judgments/. */
  judgments?: JudgmentStore;
  /** ISO timestamp recorded on findings. */
  now?: string;
  /** Extra team packs (paths relative to the metarepo root), on top of the owning teams' packs. */
  teamPacks?: string[];
  /** Plugin checks, by id. */
  checks?: DeterministicCheckDef[];
  /** The model that wrote the artifacts, so the critic can pick another family. */
  authorModel?: string;
  maxClassification?: string;
  /**
   * A stage's draft (ADR 0115): the change-folder files it wrote, which the AI lenses review
   * with the artifacts it was drafted from, and the estate the drafter read, as data.
   */
  review?: { stage: string; files: string[]; sources: SourceInput[] };
  /**
   * Where the code has a name a lens's finding says is missing (W1). Default: the search the
   * command line registered (registerCodeSearch); without one, only the catalog is checked.
   */
  codeSearch?: CodeSearch;
}

/** The change-folder files a lens reads that aren't artifacts (a stage's draft), as documents. */
export async function draftDocs(dir: string, files: string[]): Promise<Doc[]> {
  const out: Doc[] = [];
  for (const rel of [...new Set(files)].sort()) {
    if (rel.split("/").includes("..") || !/\.(md|ya?ml)$/.test(rel)) continue;
    const text = await readFile(join(dir, ...rel.split("/")), "utf8").catch(() => undefined);
    if (text !== undefined) out.push(parseDoc(rel, text));
  }
  return out;
}

/**
 * Where a hand-off lens run keeps the draft it was given, in the run's own folder: its answer is
 * checked against the text it reviewed, even when the draft is edited before it is read in.
 */
export const DRAFT_DIR = "draft";

export interface CriticResult {
  change: string;
  gate: string;
  round: number;
  findings: CriticFinding[];
  rules: { ran: string[]; skipped: { rule: string; reason: string }[] };
  refused: RefusedPack[];
  problems: string[];
  lenses: LensRun[];
  discarded: Discarded[];
  /** Artifacts with blocking layer-1 findings; they were kept out of layer 2. */
  failedLayer1: string[];
  model: ModelChoice;
  /**
   * The round ran past the gate's round limit, to check what a person did about every blocking
   * finding of the round before (ADR 0115 addendum). A blocking finding it raises goes to a person.
   */
  checkRound?: true;
  status: GateStatus;
}

/**
 * Run the critic on a change at a gate: layer 1 (deterministic checks and needs), then layer 2
 * (AI lenses on what passed layer 1), and write round N's findings to
 * `review/<gate>/<N>/<id>.yaml`. When the gate sets `maxAuthorRounds`, at most that many
 * rounds; after that a person decides and a further run is refused, until a person has acted on
 * every blocking finding of the newest round: then one checking round reviews what they did
 * (ADR 0115 addendum). A version 2 gates.yaml with no limit has none (ADR 0087).
 */
export async function runCritic(
  root: string,
  changeId: string,
  opts: RunCriticOptions = {},
): Promise<CriticResult> {
  const { lifecycle, change, type, gate } = await resolveGate(root, changeId, opts.gate);
  const rounds = await roundsOf(root, change.id, gate.id);
  const round = (rounds.at(-1) ?? 0) + 1;
  const max = maxRoundsOf(lifecycle, gate.id);
  const counted = max === undefined ? [] : await countedRounds(root, change.id, gate.id);
  // A person acted on every blocking finding of the newest round: one checking round past the
  // limit reviews their fixes (ADR 0115 addendum). Its own blocking findings go to a person.
  const limit =
    max !== undefined && counted.length >= max
      ? await checkRoundState(root, change.id, gate.id)
      : { openBlocking: 0, actedOn: [] as string[] };
  const actedOn = limit.actedOn;
  if (max !== undefined && counted.length >= max && actedOn.length === 0) {
    const past = counted.length - max;
    const had = `The ${gate.id} gate has had ${max} critic round${max > 1 ? "s" : ""}, the most it allows${past > 0 ? `, and ${past === 1 ? "a checking round" : `${past} checking rounds`} past it` : ""}.`;
    // Never ask a person to act on blocking findings there aren't (ADR 0115 addendum).
    throw new CriticError(
      "round-limit",
      limit.openBlocking
        ? `${had} A person decides now: act on each blocking finding of round ${counted.at(-1)} (fix it by hand and apply, waive it with a reason, or dismiss it as not relevant); once every one is acted on, ${checkRoundRule(counted.at(-1))}; or return the change.`
        : `${had} Nothing blocking is open in round ${counted.at(-1)}, but nobody has acted since it ran, so no checking round is due. A person decides now: answer the change's open questions (atticus questions), or act on one of round ${counted.at(-1)}'s findings (atticus findings ${change.id}); once you have, ${checkRoundRule(counted.at(-1))}; or return the change.`,
    );
  }
  const checkRound = actedOn.length ? { after: counted.at(-1)!, actedOn } : undefined;
  const now = opts.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const { ctx, applicable, layered, problems, skipped } = await prepareLayers(
    root,
    { lifecycle, change, type, gate },
    now,
    opts.teamPacks ?? [],
  );

  // The judgments of meaning the checks read (ADR 0117 addendum), settled before they run: a fact
  // that settles one, a judgment on file, and the judge where the runtime calls a model.
  const personal = await settle(PERSONAL_DATA_SPEC, personalItems(ctx), {
    runtime: opts.runtime,
    store: opts.judgments ?? fileJudgments(root),
    change: change.id,
    now: new Date(now),
  });
  ctx.judged = (kind, inputs) =>
    kind === PERSONAL_DATA_SPEC.kind ? personal.get(judgmentKey(kind, inputs))?.verdict : undefined;

  // Layer 1: deterministic checks and needs, all lenses (it decides what reaches layer 2).
  const registry = checkRegistry(opts.checks);
  const l1: RuledHit[] = [];
  const ran: string[] = [];
  for (const rule of applicable) {
    if (rule.check.type !== "deterministic") {
      // An AI rule's needs are still checked here, for free: no silent passes in either layer.
      for (const hit of evaluateNeeds(ctx, rule))
        l1.push({ rule, hit: markNeedHit(hit), layer: "deterministic", also: [] });
      continue;
    }
    const def = registry.get(rule.check.check);
    if (!def) {
      problems.push(
        `Rule ${rule.id} names check ${rule.check.check}, which doesn't exist, so it did not run.`,
      );
      skipped.push({ rule: rule.id, reason: `unknown check ${rule.check.check}` });
      continue;
    }
    const params = def.params.safeParse(rule.check.params);
    if (!params.success) {
      problems.push(
        `Rule ${rule.id}: bad parameters for ${def.id}: ${params.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
      skipped.push({ rule: rule.id, reason: "bad check parameters" });
      continue;
    }
    let res;
    try {
      res = def.run(ctx, params.data, rule);
    } catch (e) {
      problems.push(`Rule ${rule.id}: check ${def.id} failed: ${(e as Error).message}`);
      skipped.push({ rule: rule.id, reason: "the check failed" });
      continue;
    }
    ran.push(rule.id);
    for (const hit of res.hits) l1.push({ rule, hit, layer: "deterministic", also: [] });
    for (const hit of evaluateNeeds(ctx, rule, res.subjects))
      l1.push({ rule, hit: markNeedHit(hit), layer: "deterministic", also: [] });
  }
  // A check may read ahead (snow.md from interfaces.md), but findings wait until their
  // artifact is due at this gate.
  const due = (h: RuledHit) => {
    const a = artifactOf(h.hit.artifact);
    return !a || ctx.isDue(a);
  };
  for (let i = l1.length - 1; i >= 0; i--) if (!due(l1[i]!)) l1.splice(i, 1);
  const noEvidence = l1.filter((h) => h.hit.evidence.length === 0);
  for (const h of noEvidence)
    problems.push(
      `Rule ${h.rule.id} produced a finding without evidence; it was discarded: ${h.hit.summary}`,
    );
  const merged1 = mergeHits(
    l1.filter((h) => h.hit.evidence.length > 0),
    ctx.systemOf,
  );
  const failed = new Set(
    merged1
      .filter(
        (h) =>
          h.hit.kind === "issue" && h.rule.severity === "blocking" && h.hit.artifact !== "catalog",
      )
      .map((h) => h.hit.artifact),
  );

  // Layer 2: AI lenses, only on artifacts that passed layer 1.
  const lenses = opts.lenses ?? [...Lens.options];
  const quarantined: QuarantineItem[] = [];
  const draft = opts.review
    ? await draftDocs(changeFolder(root, change.id), opts.review.files)
    : [];
  const ai = await runLenses(ctx, applicable, {
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    lenses,
    failed,
    ...(opts.maxClassification ? { maxClassification: opts.maxClassification } : {}),
    ...(opts.review
      ? { review: { stage: opts.review.stage, docs: draft, sources: opts.review.sources } }
      : {}),
    quarantined,
    ...(opts.codeSearch ? { codeSearch: opts.codeSearch } : {}),
  });
  // A lens handed off keeps the draft as it was given, so its answer is checked against that.
  for (const r of ai.runs)
    if (r.state === "waiting" && r.runId)
      for (const d of draft)
        await writeFileAtomic(
          join(runsDirOf(root), change.id, r.runId, DRAFT_DIR, ...d.path.split("/")),
          d.raw,
        );
  // What the defences left out of the lenses' packs, for a person (ADR 0042).
  await writeQuarantineItems(root, change.id, `${gate.id}-${round}`, quarantined);
  skipped.push(...ai.skipped);
  ran.push(...ai.runs.filter((r) => r.state === "ran").flatMap((r) => r.rules));

  const all = mergeHits([...merged1, ...ai.hits], ctx.systemOf).filter((h) =>
    lenses.includes(h.rule.lens),
  );

  const findings = await writeHits(root, all, {
    change: change.id,
    gate: gate.id,
    round,
    now,
    priorRound: rounds.at(-1),
  });

  const model = criticModel(lifecycle.orgPack.runtime, opts.authorModel);
  const metaDir = join(changeFolder(root, change.id), "review", gate.id, String(round), "meta");
  for (const r of ai.runs)
    if (r.summary)
      await writeFileAtomic(
        join(metaDir, "runs", `${r.agent}.yaml`),
        toCanonicalYaml(r.summary, ["schemaVersion", "runId"]),
      );
  await writeFileAtomic(
    join(metaDir, "round.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        change: change.id,
        gate: gate.id,
        round,
        createdAt: now,
        findings: findings.map((f) => ({
          id: f.finding.id,
          layer: f.layer,
          rule: f.finding.rule,
          severity: f.finding.severity,
          ...(f.carried ? { carried: true } : {}),
        })),
        rules: { ran: [...new Set(ran)].sort(), skipped },
        refused: layered.refused,
        problems,
        lenses: ai.runs.map((r) => ({
          lens: r.lens,
          agent: r.agent,
          state: r.state,
          ...(r.reason ? { reason: r.reason } : {}),
          rules: r.rules,
          artifacts: r.artifacts,
          ...(r.promptSha256 ? { promptSha256: r.promptSha256 } : {}),
          ...(r.runId ? { runId: r.runId } : {}),
        })),
        discarded: ai.discarded,
        failedLayer1: [...failed].sort(),
        model,
        // A checking round past the gate's limit, and the findings a person acted on that allowed it.
        ...(checkRound ? { checkRound } : {}),
      },
      ROUND_LEADING,
    ),
  );

  return {
    change: change.id,
    gate: gate.id,
    round,
    findings,
    rules: { ran: [...new Set(ran)].sort(), skipped },
    refused: layered.refused,
    problems,
    lenses: ai.runs,
    discarded: ai.discarded,
    failedLayer1: [...failed].sort(),
    model,
    ...(checkRound ? { checkRound: true } : {}),
    status: await gateStatusOf(root, lifecycle, change, gate.id),
  };
}
