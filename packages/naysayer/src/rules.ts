import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ChecklistPack, type ChecklistRule } from "@maycombhq/core";

/**
 * Rule layering. Three layers, in this order of precedence:
 *
 * - constitution: Atticus's built-in rules (constitution/constitution.yaml) plus any rule an
 *   org pack marks `layer: constitution`. Never waivable; only ever tightened.
 * - org: the org pack's checklists the gate names (all of them when the gate names none),
 *   plus the rules a chosen integration pattern adds.
 * - team: team packs, which may add rules or tighten any rule, and never drop or loosen one.
 *
 * `tightens: X` replaces X with a stricter version (same check, same lens, severity and scope
 * at least as strict, no needs dropped, never made waivable). `extends: X` adds a new rule
 * that inherits X's check parameters and needs. A pack that drops or loosens a constitution
 * rule is refused as a whole and reported; so is a team pack that declares non-team rules.
 */

export type RuleOrigin = "constitution" | "org" | "team";

export interface PackSource {
  pack: ChecklistPack;
  /** Where the pack came from, for findings and reports ("built-in" for the constitution). */
  file: string;
  /** Which layer the file sits in; a rule's own `layer` must fit it. */
  origin: RuleOrigin;
}

export interface EffectiveRule extends ChecklistRule {
  /** The layer findings carry: the strictest of the rule's and any rule it tightens. */
  effectiveLayer: ChecklistRule["layer"];
  pack: string;
  file: string;
  /** Rule ids this one replaced by tightening. */
  replaces: string[];
}

export interface RefusedPack {
  pack: string;
  file: string;
  rule?: string;
  reason: string;
}

export interface LayeredRules {
  rules: EffectiveRule[];
  refused: RefusedPack[];
  problems: string[];
}

const LAYER_RANK = { constitution: 0, org: 1, team: 2 } as const;
const SEVERITY_RANK = { blocking: 2, risk: 1, idea: 0 } as const;

export const strictestLayer = (a: ChecklistRule["layer"], b: ChecklistRule["layer"]) =>
  LAYER_RANK[a] <= LAYER_RANK[b] ? a : b;

const needKey = (n: ChecklistRule["needs"][number]) => `${n.kind}|${n.field ?? ""}|${n.scope}`;

/** Why `next` is looser than `base`; empty when it is at least as strict. */
export function loosenings(base: ChecklistRule, next: ChecklistRule): string[] {
  const out: string[] = [];
  if (next.status !== "active" && base.status === "active")
    out.push(`it sets status ${next.status}, which drops the rule`);
  if (SEVERITY_RANK[next.severity] < SEVERITY_RANK[base.severity])
    out.push(`it lowers severity from ${base.severity} to ${next.severity}`);
  // A risk never blocks, so turning it into a waivable blocker is still stricter.
  if (next.waivable && !base.waivable && base.severity === "blocking")
    out.push("it makes the rule waivable");
  if (base.evidenceRequired && !next.evidenceRequired) out.push("it stops requiring evidence");
  if (next.lens !== base.lens)
    out.push(`it moves the rule from the ${base.lens} lens to ${next.lens}`);
  const missing = base.appliesTo.artifacts.filter((a) => !next.appliesTo.artifacts.includes(a));
  if (missing.length) out.push(`it no longer looks at ${missing.join(", ")}`);
  const bt = base.appliesTo.changeTypes;
  const nt = next.appliesTo.changeTypes;
  if (nt.length > 0 && (bt.length === 0 || bt.some((t) => !nt.includes(t))))
    out.push("it applies to fewer change types");
  if (base.check.type !== next.check.type)
    out.push(`it swaps a ${base.check.type} check for a ${next.check.type} one`);
  else if (
    base.check.type === "deterministic" &&
    next.check.type === "deterministic" &&
    base.check.check !== next.check.check
  )
    out.push(`it swaps check ${base.check.check} for ${next.check.check}`);
  const have = new Set(next.needs.map(needKey));
  const dropped = base.needs.filter((n) => !have.has(needKey(n)));
  if (dropped.length)
    out.push(
      `it drops needed facts (${dropped.map((n) => (n.field ? `${n.kind}.${n.field}` : n.kind)).join(", ")})`,
    );
  return out;
}

const CONSTITUTION_FILE = fileURLToPath(
  new URL("../constitution/constitution.yaml", import.meta.url),
);

/** The built-in constitution, validated against C3 like any other pack. */
export async function loadConstitution(): Promise<ChecklistPack> {
  const data = parse(await readFile(CONSTITUTION_FILE, "utf8"));
  const pack = ChecklistPack.parse(data);
  for (const r of pack.rules)
    if (r.layer !== "constitution")
      throw new Error(`constitution rule ${r.id} has layer ${r.layer}`);
  return pack;
}

/**
 * The starter review (ADR 0119): AI rules for the critic's lenses that `atticus init` and
 * `atticus adopt` write into the org pack, and `atticus upgrade` adds once to a metarepo that
 * has no AI review of its own. Organisation configuration, not the constitution: the critic
 * never loads this file itself, only the copy in the org pack, which the org changes or deletes.
 */
export const STARTER_REVIEW_FILE = fileURLToPath(
  new URL("../starter/review.yaml", import.meta.url),
);

/** Where the starter review goes, relative to the org pack. */
export const STARTER_REVIEW_PATH = "checklists/review.yaml";

/** The starter review's text, comments and all, as it is written into the org pack. */
export async function starterReviewText(): Promise<string> {
  return readFile(STARTER_REVIEW_FILE, "utf8");
}

/** Read every checklist file under a folder, validated against C3. Problems are collected. */
export async function readPackFiles(
  root: string,
  dir: string,
): Promise<{ packs: { pack: ChecklistPack; file: string }[]; problems: string[] }> {
  const packs: { pack: ChecklistPack; file: string }[] = [];
  const problems: string[] = [];
  const files: string[] = [];
  async function walkDir(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walkDir(full);
      else if (/\.ya?ml$/.test(e.name)) files.push(full);
    }
  }
  await walkDir(dir);
  for (const f of files) {
    const rel = relative(root, f).split(sep).join("/");
    const r = await readPack(f);
    if ("pack" in r) packs.push({ pack: r.pack, file: rel });
    else problems.push(`${rel}: ${r.problem}`);
  }
  return { packs, problems };
}

export async function readPack(
  path: string,
): Promise<{ pack: ChecklistPack } | { problem: string }> {
  let data: unknown;
  try {
    data = parse(await readFile(path, "utf8"));
  } catch (e) {
    return { problem: `can't read YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  const r = ChecklistPack.safeParse(data);
  if (!r.success)
    return {
      problem: r.error.issues
        .map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`)
        .join("; "),
    };
  return { pack: r.data };
}

function mergeParams(base: ChecklistRule, rule: ChecklistRule): ChecklistRule {
  if (base.check.type !== "deterministic" || rule.check.type !== "deterministic") return rule;
  if (base.check.check !== rule.check.check) return rule;
  const have = new Set(rule.needs.map(needKey));
  return {
    ...rule,
    check: { ...rule.check, params: { ...base.check.params, ...rule.check.params } },
    needs: [...rule.needs, ...base.needs.filter((n) => !have.has(needKey(n)))],
  };
}

/**
 * Layer packs into the rules that run. Sources are given constitution first, then org, then
 * team; within a layer, in the order given.
 */
export function layerRules(sources: PackSource[]): LayeredRules {
  const ordered = [...sources].sort((a, b) => LAYER_RANK[a.origin] - LAYER_RANK[b.origin]);
  const refused: RefusedPack[] = [];
  const problems: string[] = [];
  const active = new Map<string, EffectiveRule>();
  /** Every id seen, active or replaced, so a rule can't come back under its old name. */
  const seen = new Map<string, EffectiveRule>();

  for (const src of ordered) {
    const name = src.pack.name;
    const refuse = (reason: string, rule?: string) =>
      refused.push({ pack: name, file: src.file, ...(rule ? { rule } : {}), reason });

    // A team pack may only declare team rules; the constitution only constitution rules.
    const wrongLayer = src.pack.rules.find((r) =>
      src.origin === "team"
        ? r.layer !== "team"
        : src.origin === "constitution"
          ? r.layer !== "constitution"
          : false,
    );
    if (wrongLayer) {
      refuse(
        `a ${src.origin} pack can't declare ${wrongLayer.layer} rules (rule ${wrongLayer.id})`,
        wrongLayer.id,
      );
      continue;
    }

    // Check the whole pack before taking any of it: one bad rule refuses a team pack.
    const staged: { rule: ChecklistRule; replaces?: EffectiveRule }[] = [];
    const errors: { rule: string; reason: string; constitution: boolean }[] = [];
    const local = new Map(src.pack.rules.map((r) => [r.id, r]));
    for (const r of src.pack.rules) {
      if (seen.has(r.id)) {
        const prior = seen.get(r.id)!;
        errors.push({
          rule: r.id,
          reason: `it redefines rule ${r.id} from ${prior.pack}; add a rule that tightens it instead`,
          constitution: prior.effectiveLayer === "constitution",
        });
        continue;
      }
      const target = r.tightens ?? r.extends;
      if (!target) {
        staged.push({ rule: r });
        continue;
      }
      const base = active.get(target) ?? (local.has(target) ? undefined : seen.get(target));
      const localBase = local.get(target);
      if (!base && !localBase) {
        errors.push({
          rule: r.id,
          reason: `it ${r.tightens ? "tightens" : "extends"} ${target}, which doesn't exist or was already replaced`,
          constitution: false,
        });
        continue;
      }
      const baseRule: ChecklistRule = base ?? localBase!;
      const baseLayer = base?.effectiveLayer ?? localBase!.layer;
      if (r.extends && baseLayer === "constitution") {
        errors.push({
          rule: r.id,
          reason: `a constitution rule (${target}) can only be tightened, not extended`,
          constitution: true,
        });
        continue;
      }
      if (r.tightens) {
        const why = loosenings(baseRule, r);
        if (why.length) {
          errors.push({
            rule: r.id,
            reason: `it loosens ${target}: ${why.join("; ")}`,
            constitution: baseLayer === "constitution",
          });
          continue;
        }
        staged.push({ rule: r, ...(base ? { replaces: base } : {}) });
      } else staged.push({ rule: mergeParams(baseRule, r) });
    }

    const hitsConstitution = errors.some((e) => e.constitution);
    if (errors.length && (src.origin === "team" || hitsConstitution)) {
      for (const e of errors) refuse(e.reason, e.rule);
      if (src.origin !== "team")
        problems.push(`${src.file}: refused because it drops or loosens a constitution rule`);
      continue;
    }
    for (const e of errors) {
      refuse(e.reason, e.rule);
      problems.push(`${src.file}: rule ${e.rule} left out: ${e.reason}`);
    }

    // Plain rules first, then tightenings, so a pack may tighten its own rules.
    for (const { rule } of staged.filter((s) => !s.rule.tightens)) {
      const eff: EffectiveRule = {
        ...rule,
        effectiveLayer: rule.layer,
        pack: name,
        file: src.file,
        replaces: [],
      };
      active.set(rule.id, eff);
      seen.set(rule.id, eff);
    }
    for (const { rule, replaces } of staged.filter((s) => s.rule.tightens)) {
      const base = replaces ?? active.get(rule.tightens!);
      if (!base) continue;
      active.delete(base.id);
      const eff: EffectiveRule = {
        ...rule,
        effectiveLayer: strictestLayer(base.effectiveLayer, rule.layer),
        waivable:
          rule.waivable && strictestLayer(base.effectiveLayer, rule.layer) !== "constitution",
        pack: name,
        file: src.file,
        replaces: [...base.replaces, base.id],
      };
      active.set(rule.id, eff);
      seen.set(rule.id, eff);
    }
  }
  return { rules: [...active.values()], refused, problems };
}

export const layerRank = (l: ChecklistRule["layer"]) => LAYER_RANK[l];
export const severityRank = (s: ChecklistRule["severity"]) => SEVERITY_RANK[s];
