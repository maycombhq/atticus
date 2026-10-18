import { join } from "node:path";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  changeTypeOf,
  loadChangeContext,
  phaseGates,
  statePhase,
  writeFileAtomic,
} from "@maycombhq/changes";
import { Finding, Lens, toCanonicalYaml, type ChecklistPack } from "@maycombhq/core";
import type { AiRuntime } from "@maycombhq/ai";
import { runLenses, type Discarded, type LensName, type LensRun } from "./ai.js";
import { artifactOf, readChangeFiles } from "./artifacts.js";
import { checkRegistry } from "./checks/index.js";
import { buildContext, type CriticContext } from "./context.js";
import { CriticError } from "./errors.js";
import {
  findingIdFor,
  fingerprint,
  markNeedHit,
  mergeHits,
  readRound,
  roundsOf,
  toFinding,
  writeFinding,
  type Layer,
  type RuledHit,
} from "./findings.js";
import { gateStatusOf, maxRoundsOf, type GateStatus } from "./gates.js";
import type { DeterministicCheckDef } from "./hits.js";
import { criticModel, type ModelChoice } from "./model.js";
import { evaluateNeeds } from "./needs.js";
import {
  layerRules,
  loadConstitution,
  readPack,
  readPackFiles,
  type EffectiveRule,
  type PackSource,
  type RefusedPack,
} from "./rules.js";

export const CONSTITUTION_FILE_LABEL = "@maycombhq/naysayer/constitution/constitution.yaml";

export interface RunCriticOptions {
  /** Gate id from gates.yaml. Default: the gate of the change's current phase. */
  gate?: string;
  /** Lenses whose findings are written. Layer 1 always runs whole, to decide what reaches layer 2. */
  lenses?: LensName[];
  /** The AI runtime for layer 2 (mock or replay in tests). Without it, only layer 1 runs. */
  runtime?: AiRuntime;
  /** ISO timestamp recorded on findings. */
  now?: string;
  /** Extra team packs (paths relative to the metarepo root), on top of the owning teams' packs. */
  teamPacks?: string[];
  /** Plugin checks, by id. */
  checks?: DeterministicCheckDef[];
  /** The model that wrote the artifacts, so the critic can pick another family. */
  authorModel?: string;
  maxClassification?: string;
}

export interface CriticFinding {
  finding: Finding;
  /** Change-folder-relative path of the finding file. */
  path: string;
  /** Which layer raised it. */
  layer: Layer;
  /** True when its state came from the previous round (dismissed, waived or asked before). */
  carried: boolean;
}

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
  status: GateStatus;
}

/** Packs that apply to a change, in layer order, with where each came from. */
async function ruleSources(
  ctx: CriticContext,
  teamPacks: string[],
): Promise<{ sources: PackSource[]; problems: string[] }> {
  const problems: string[] = [];
  const sources: PackSource[] = [
    { pack: await loadConstitution(), file: CONSTITUTION_FILE_LABEL, origin: "constitution" },
  ];
  const orgDir = join(ctx.root, "org-pack");
  const org = await readPackFiles(ctx.root, join(orgDir, "checklists"));
  const named = ctx.gate.checklists;
  const chosen = named.length ? org.packs.filter((p) => named.includes(p.pack.name)) : org.packs;
  for (const n of named)
    if (!org.packs.some((p) => p.pack.name === n))
      problems.push(`gates.yaml: gate ${ctx.gate.id} names checklist ${n}, which doesn't exist.`);
  for (const p of chosen) sources.push({ ...p, origin: "org" });

  // Rules a chosen pattern adds, from packs the gate doesn't already run.
  const used = new Set<string>(ctx.hops.map((h) => h.pattern));
  for (const t of ctx.footprint.interfaces) {
    const code = ctx.get("Interface", t.id)?.pattern?.code;
    if (code) used.add(code);
  }
  const wanted = new Set([...used].flatMap((c) => ctx.patterns.get(c)?.checklist ?? []));
  const have = new Set(chosen.flatMap((p) => p.pack.rules.map((r) => r.id)));
  for (const p of org.packs) {
    if (chosen.includes(p)) continue;
    const rules = p.pack.rules.filter((r) => wanted.has(r.id) && !have.has(r.id));
    if (rules.length)
      sources.push({ pack: { ...p.pack, rules } as ChecklistPack, file: p.file, origin: "org" });
  }

  // Team packs: org-pack/teams/<team>/checklists/ for each team owning a touched system.
  const owners = new Set(
    ctx.footprint.systems.map((s) => ctx.ownerOf(s)).filter((x): x is string => !!x),
  );
  for (const team of [...owners].sort()) {
    const t = await readPackFiles(ctx.root, join(orgDir, "teams", team, "checklists"));
    problems.push(...t.problems);
    for (const p of t.packs) sources.push({ ...p, origin: "team" });
  }
  for (const rel of teamPacks) {
    const r = await readPack(join(ctx.root, rel));
    if ("pack" in r) sources.push({ pack: r.pack, file: rel, origin: "team" });
    else problems.push(`${rel}: ${r.problem}`);
  }
  return { sources, problems };
}

/** Why a rule doesn't apply at this gate, or undefined when it does. */
function notApplicable(ctx: CriticContext, r: EffectiveRule): string | undefined {
  if (r.status !== "active") return `status ${r.status}`;
  if (r.appliesTo.changeTypes.length && !r.appliesTo.changeTypes.includes(ctx.type.id))
    return `it applies to ${r.appliesTo.changeTypes.join(", ")}, not ${ctx.type.id}`;
  if (ctx.type.lenses.length && !ctx.type.lenses.includes(r.lens))
    return `change type ${ctx.type.id} doesn't use the ${r.lens} lens`;
  if (!r.appliesTo.artifacts.some((a) => ctx.isDue(a)))
    return `its artifacts (${r.appliesTo.artifacts.join(", ")}) aren't due at the ${ctx.gate.id} gate`;
  return undefined;
}

const ROUND_LEADING = ["schemaVersion", "change", "gate", "round", "createdAt"];

/**
 * Run the critic on a change at a gate: layer 1 (deterministic checks and needs), then layer 2
 * (AI lenses on what passed layer 1), and write round N's findings to
 * `review/<gate>/<N>/<id>.yaml`. At most the gate's `maxAuthorRounds` rounds (default two);
 * after that a person decides and a further run is refused.
 */
export async function runCritic(
  root: string,
  changeId: string,
  opts: RunCriticOptions = {},
): Promise<CriticResult> {
  const lifecycle = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new CriticError("not-found", e.message);
    });
  const type = changeTypeOf(lifecycle, change.type);
  const phase =
    statePhase(change.state) ?? (change.state === "returned" ? type.phases[0] : undefined);
  const gateId = opts.gate ?? (phase ? phaseGates(lifecycle, phase)[0] : undefined);
  const gate = lifecycle.orgPack.gates.gates.find((g) => g.id === gateId);
  if (!gate)
    throw new CriticError(
      "no-gate",
      gateId
        ? `There is no gate ${gateId}. Gates: ${lifecycle.orgPack.gates.gates.map((g) => g.id).join(", ")}.`
        : `${change.id} is ${change.state}, which has no gate; name one with --gate.`,
    );
  const rounds = await roundsOf(root, change.id, gate.id);
  const round = (rounds.at(-1) ?? 0) + 1;
  const max = maxRoundsOf(lifecycle, gate.id);
  if (round > max)
    throw new CriticError(
      "round-limit",
      `The ${gate.id} gate has had ${max} critic round${max > 1 ? "s" : ""}, the most it allows. A person decides now: fix and dismiss, waive (stage owner), or return the change.`,
    );
  const now = opts.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const footprint = await changeFootprint(lifecycle, change);
  const files = await readChangeFiles(changeFolder(root, change.id));
  const ctx = buildContext({ root, change, type, lifecycle, footprint, files, gate, now });

  const { sources, problems } = await ruleSources(ctx, opts.teamPacks ?? []);
  const layered = layerRules(sources);
  problems.push(...layered.problems);
  const skipped: { rule: string; reason: string }[] = [];
  const applicable: EffectiveRule[] = [];
  for (const r of layered.rules) {
    const why = notApplicable(ctx, r);
    if (why) skipped.push({ rule: r.id, reason: why });
    else applicable.push(r);
  }

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
  const ai = await runLenses(ctx, applicable, {
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    lenses,
    failed,
    ...(opts.maxClassification ? { maxClassification: opts.maxClassification } : {}),
  });
  skipped.push(...ai.skipped);
  ran.push(...ai.runs.filter((r) => r.state === "ran").flatMap((r) => r.rules));

  const all = mergeHits([...merged1, ...ai.hits], ctx.systemOf).filter((h) =>
    lenses.includes(h.rule.lens),
  );

  // Carry people's decisions forward: a problem dismissed, waived or asked about in the last
  // round keeps that resolution if it comes up again unchanged.
  const prior = new Map<string, Finding>();
  if (rounds.length) {
    const last = await readRound(root, change.id, gate.id, rounds.at(-1)!);
    for (const s of last.findings)
      if (["dismissed", "waived", "asked"].includes(s.finding.state))
        prior.set(fingerprint(s.finding), s.finding);
  }

  const taken = new Set<string>();
  const findings: CriticFinding[] = [];
  for (const h of all) {
    const id = findingIdFor(h, taken);
    let f = toFinding(h, { id, change: change.id, gate: gate.id, round, now });
    const before = prior.get(fingerprint(f));
    let carried = false;
    if (before?.resolution) {
      const next = Finding.safeParse({ ...f, state: before.state, resolution: before.resolution });
      if (next.success) {
        f = next.data;
        carried = true;
      }
    }
    await writeFinding(root, f);
    findings.push({
      finding: f,
      path: `review/${gate.id}/${round}/${id}.yaml`,
      layer: h.layer,
      carried,
    });
  }

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
        })),
        discarded: ai.discarded,
        failedLayer1: [...failed].sort(),
        model,
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
    status: await gateStatusOf(root, lifecycle, change, gate.id),
  };
}
