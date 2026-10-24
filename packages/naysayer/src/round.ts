import { join } from "node:path";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  changeTypeOf,
  loadChangeContext,
  phaseGates,
  statePhase,
  type ChangeContext,
} from "@maycombhq/changes";
import {
  Finding,
  orgPackDirOf,
  type ChangeLifecycle,
  type ChangeType,
  type ChecklistPack,
} from "@maycombhq/core";
import { changeAnswers } from "./answers.js";
import { readChangeFiles } from "./artifacts.js";
import { buildContext, type CriticContext, type GateDef } from "./context.js";
import { CriticError } from "./errors.js";
import {
  askedElsewhere,
  findingIdFor,
  fingerprint,
  readRound,
  toFinding,
  writeFinding,
  type Layer,
  type RuledHit,
} from "./findings.js";
import {
  layerRules,
  loadConstitution,
  readPack,
  readPackFiles,
  type EffectiveRule,
  type PackSource,
} from "./rules.js";

/**
 * The parts of a critic round that `runCritic` (a whole round) and `completeLensRun` (one AI
 * lens read in later, hand-off) share: which gate, the rules in force, and turning hits into
 * the round's finding files.
 */

export const CONSTITUTION_FILE_LABEL = "@maycombhq/naysayer/constitution/constitution.yaml";

/** Packs that apply to a change, in layer order, with where each came from. */
async function ruleSources(
  ctx: CriticContext,
  teamPacks: string[],
): Promise<{ sources: PackSource[]; problems: string[] }> {
  const problems: string[] = [];
  const sources: PackSource[] = [
    { pack: await loadConstitution(), file: CONSTITUTION_FILE_LABEL, origin: "constitution" },
  ];
  const orgDir = join(orgPackDirOf(ctx.root));
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

/** Keys printed first in `meta/round.yaml`. */
export const ROUND_LEADING = ["schemaVersion", "change", "gate", "round", "createdAt"];

export interface GateChoice {
  lifecycle: ChangeContext;
  change: ChangeLifecycle;
  type: ChangeType;
  gate: GateDef;
}

/** The change and the gate to review: the one named, or the gate of the change's phase. */
export async function resolveGate(
  root: string,
  changeId: string,
  gateId?: string,
): Promise<GateChoice> {
  const lifecycle = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new CriticError("not-found", e.message);
    });
  const type = changeTypeOf(lifecycle, change.type);
  const phase =
    statePhase(change.state) ?? (change.state === "returned" ? type.phases[0] : undefined);
  const id = gateId ?? (phase ? phaseGates(lifecycle, phase)[0] : undefined);
  const gate = lifecycle.orgPack.gates.gates.find((g) => g.id === id);
  if (!gate)
    throw new CriticError(
      "no-gate",
      id
        ? `There is no gate ${id}. Gates: ${lifecycle.orgPack.gates.gates.map((g) => g.id).join(", ")}.`
        : `${change.id} is ${change.state}, which has no gate; name one with --gate.`,
    );
  return { lifecycle, change, type, gate };
}

export interface Layers {
  ctx: CriticContext;
  /** The rules in force at this gate for this change. */
  applicable: EffectiveRule[];
  layered: ReturnType<typeof layerRules>;
  problems: string[];
  skipped: { rule: string; reason: string }[];
}

/** The critic's context (the change's files, the catalog) and the rules that apply at the gate. */
export async function prepareLayers(
  root: string,
  g: GateChoice,
  now: string,
  teamPacks: string[],
): Promise<Layers> {
  const { lifecycle, change, type, gate } = g;
  const footprint = await changeFootprint(lifecycle, change);
  const files = await readChangeFiles(changeFolder(root, change.id));
  const ctx = buildContext({ root, change, type, lifecycle, footprint, files, gate, now });
  // What people answered for the change: part of the brief the lenses review against.
  ctx.answers = await changeAnswers(root, change.id);

  const { sources, problems } = await ruleSources(ctx, teamPacks);
  const layered = layerRules(sources);
  problems.push(...layered.problems);
  const skipped: { rule: string; reason: string }[] = [];
  const applicable: EffectiveRule[] = [];
  for (const r of layered.rules) {
    const why = notApplicable(ctx, r);
    if (why) skipped.push({ rule: r.id, reason: why });
    else applicable.push(r);
  }
  return { ctx, applicable, layered, problems, skipped };
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

/**
 * Write hits as findings in a round. Ids are unique in the round (`taken` holds those already
 * there). A problem dismissed, waived or asked about in the round before (`priorRound`) keeps
 * that resolution if it comes up again unchanged, and an owner question already asked at
 * another gate and still open is not asked again.
 */
export async function writeHits(
  root: string,
  hits: RuledHit[],
  o: {
    change: string;
    gate: string;
    round: number;
    now: string;
    priorRound?: number | undefined;
    taken?: Set<string>;
  },
): Promise<CriticFinding[]> {
  const prior = new Map<string, Finding>();
  if (o.priorRound !== undefined) {
    const last = await readRound(root, o.change, o.gate, o.priorRound);
    for (const s of last.findings)
      if (["dismissed", "waived", "asked"].includes(s.finding.state))
        prior.set(fingerprint(s.finding), s.finding);
  }
  const elsewhere = await askedElsewhere(root, o.change, o.gate);
  const taken = o.taken ?? new Set<string>();
  const findings: CriticFinding[] = [];
  for (const h of hits) {
    const id = findingIdFor(h, taken);
    let f = toFinding(h, { id, change: o.change, gate: o.gate, round: o.round, now: o.now });
    const before = prior.get(fingerprint(f));
    let carried = false;
    if (before?.resolution) {
      const next = Finding.safeParse({ ...f, state: before.state, resolution: before.resolution });
      if (next.success) {
        f = next.data;
        carried = true;
      }
    }
    const first = f.kind === "knowledge-gap" && f.state === "open" && elsewhere.get(fingerprint(f));
    if (first) {
      const next = Finding.safeParse({ ...f, state: "asked", resolution: first });
      if (next.success) {
        f = next.data;
        carried = true;
      }
    }
    await writeFinding(root, f);
    findings.push({
      finding: f,
      path: `review/${o.gate}/${o.round}/${id}.yaml`,
      layer: h.layer,
      carried,
    });
  }
  return findings;
}
