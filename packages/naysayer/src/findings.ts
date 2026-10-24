import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { Finding, findingPath, toCanonicalYaml } from "@maycombhq/core";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import { changeAnswers } from "./answers.js";
import { decidedAt, decidedReason } from "./recorded.js";
import type { Hit } from "./hits.js";
import { layerRank, severityRank, type EffectiveRule } from "./rules.js";

/** Keys printed first in a finding file, in this order; the rest alphabetical. */
const LEADING = [
  "schemaVersion",
  "id",
  "kind",
  "change",
  "gate",
  "round",
  "rule",
  "layer",
  "lens",
  "severity",
  "artifact",
  "locator",
  "summary",
  "why",
  "fix",
  "evidence",
  "question",
  "answered",
  "waivable",
  "state",
  "resolution",
  "createdAt",
  "source",
  "record",
  "path",
  "repo",
  "line",
  "quote",
  "heading",
  "field",
  "text",
  "owner",
  "action",
  "by",
  "at",
  "reason",
  "askedOf",
];

export type Layer = "deterministic" | "ai";

/** A hit with the rule that raised it, before it becomes a finding. */
export interface RuledHit {
  rule: EffectiveRule;
  hit: Hit;
  layer: Layer;
  /** Other rules that caught the same problem (merged into this one). */
  also: string[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * One finding per problem: hits with the same key are merged, keeping the strictest rule
 * (constitution before org before team, then blocking before risk before idea). Within one
 * rule, a gap the check raised about a record replaces the generic need gap about the same
 * record or its system.
 */
export function mergeHits(
  all: RuledHit[],
  systemOf: (id: string) => string | undefined,
): RuledHit[] {
  // Within a rule: a check's own gap wins over the need gap about the same subject.
  const byRule = new Map<string, RuledHit[]>();
  for (const h of all) byRule.set(h.rule.id, [...(byRule.get(h.rule.id) ?? []), h]);
  const kept: RuledHit[] = [];
  for (const hits of byRule.values()) {
    const checkGaps = hits.filter((h) => h.hit.kind === "knowledge-gap" && !isNeedHit(h));
    for (const h of hits) {
      if (isNeedHit(h)) {
        const s = h.hit.subject!;
        const covered = checkGaps.some((c) => {
          const o = c.hit.subject;
          return !!o && (o === s || systemOf(o) === s || systemOf(s) === o);
        });
        if (covered) continue;
      }
      kept.push(h);
    }
  }
  const rank = (h: RuledHit) =>
    h.hit.kind === "knowledge-gap" ? -1 : severityRank(h.rule.severity);
  // Stable sort: equal ranks keep the order rules were given in.
  kept.sort(
    (a, b) =>
      layerRank(a.rule.effectiveLayer) - layerRank(b.rule.effectiveLayer) || rank(b) - rank(a),
  );
  const byKey = new Map<string, RuledHit>();
  const out: RuledHit[] = [];
  for (const h of kept) {
    const prior = byKey.get(h.hit.key);
    if (prior) {
      if (!prior.also.includes(h.rule.id) && prior.rule.id !== h.rule.id)
        prior.also.push(h.rule.id);
      continue;
    }
    byKey.set(h.hit.key, h);
    out.push(h);
  }
  return out;
}

const needHits = new WeakSet<Hit>();
/** Mark hits that came from a rule's `needs` rather than its check. */
export const markNeedHit = (h: Hit) => {
  needHits.add(h);
  return h;
};
const isNeedHit = (h: RuledHit) => needHits.has(h.hit);

/** A stable, readable id: rule, artifact and line or record. */
export function findingIdFor(h: RuledHit, taken: Set<string>): string {
  const tail = h.rule.id.replace(/^constitution\./, "");
  const art =
    h.hit.artifact === "catalog"
      ? ""
      : (h.hit.artifact.split("/").pop() ?? "").replace(/\.md$/, "");
  const where = h.hit.locator.line
    ? `l${h.hit.locator.line}`
    : (h.hit.subject ?? h.hit.locator.record ?? "");
  let base = slug(
    [h.hit.kind === "knowledge-gap" ? "gap" : "", tail, art, where].filter(Boolean).join("-"),
  ).slice(0, 110);
  if (!/^[a-z0-9]/.test(base)) base = `f-${base}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

/** Same problem across rounds: rule, artifact, record and summary (lines move when files are edited). */
export function fingerprint(f: Pick<Finding, "rule" | "artifact" | "summary" | "locator">): string {
  return [f.rule, f.artifact, f.locator.record ?? "", f.summary].join("|");
}

export function toFinding(
  h: RuledHit,
  o: { id: string; change: string; gate: string; round: number; now: string },
): Finding {
  const gap = h.hit.kind === "knowledge-gap";
  const layer = h.rule.effectiveLayer;
  // A finding about what a person decided by answering (ADR 0115 addendum, 2026-10-24) doesn't
  // block: they already made the decision a waiver would be. Only where a waiver could be: a
  // constitution rule, or one that says it can't be waived, still blocks.
  const decided =
    !gap &&
    !!h.hit.answered &&
    h.rule.severity === "blocking" &&
    h.rule.waivable &&
    layer !== "constitution";
  // A finding that says something is missing, when Atticus found it (W1): a note citing where,
  // never dropped. A person reads the lens's point beside the place the code or catalog has it.
  const found = h.hit.found?.length ? h.hit.found : undefined;
  if (found) return foundNote(h, found, o, layer);
  const severity = gap ? "gap" : decided ? "risk" : h.rule.severity;
  const why = h.also.length ? `${h.hit.why} Also caught by ${h.also.join(", ")}.` : h.hit.why;
  return Finding.parse({
    schemaVersion: 1,
    id: o.id,
    kind: gap ? "knowledge-gap" : "issue",
    change: o.change,
    gate: o.gate,
    round: o.round,
    rule: h.rule.id,
    layer,
    lens: h.rule.lens,
    severity,
    artifact: h.hit.artifact,
    locator: h.hit.locator,
    summary: h.hit.summary,
    why,
    fix: h.hit.fix,
    evidence: h.hit.evidence,
    ...(h.hit.question ? { question: h.hit.question } : {}),
    ...(!gap && h.hit.answered ? { answered: h.hit.answered } : {}),
    waivable: !gap && severity === "blocking" && h.rule.waivable && layer !== "constitution",
    state: "open",
    createdAt: o.now,
  });
}

/** A finding whose missing names Atticus found: an idea (a note), citing each place found. */
function foundNote(
  h: RuledHit,
  found: NonNullable<Hit["found"]>,
  o: { id: string; change: string; gate: string; round: number; now: string },
  layer: RuledHit["rule"]["effectiveLayer"],
): Finding {
  const where = found.map((f) => `${f.name} ${f.record ? `as ${f.at}` : `in the code (${f.at})`}`);
  const evidence = [
    ...h.hit.evidence,
    ...found.map((f) =>
      f.record
        ? { source: "catalog" as const, record: f.record }
        : {
            source: "code" as const,
            ...(f.repo ? { repo: f.repo } : {}),
            ...(f.path ? { path: f.path } : {}),
            ...(f.line ? { line: f.line } : {}),
            quote: f.name.slice(0, 200),
          },
    ),
  ].filter((e) => "record" in e || "path" in e);
  return Finding.parse({
    schemaVersion: 1,
    id: o.id,
    kind: "issue",
    change: o.change,
    gate: o.gate,
    round: o.round,
    rule: h.rule.id,
    layer,
    lens: h.rule.lens,
    severity: "idea",
    artifact: h.hit.artifact,
    locator: h.hit.locator,
    summary: h.hit.summary,
    why: `${h.hit.why} The lens said ${found.length === 1 ? "this is" : "these are"} missing, but Atticus found ${where.join("; ")}, so this is a note, not a ${h.hit.kind === "knowledge-gap" ? "gap" : h.rule.severity} finding: check whether what is there does what the change needs.`,
    fix: h.hit.fix,
    evidence,
    waivable: false,
    state: "open",
    createdAt: o.now,
  });
}

export function serializeFinding(f: Finding): string {
  return toCanonicalYaml(Finding.parse(f), LEADING);
}

export async function writeFinding(root: string, f: Finding): Promise<string> {
  const path = join(changeFolder(root, f.change), findingPath(f));
  await writeFileAtomic(path, serializeFinding(f));
  return path;
}

export interface StoredFinding {
  finding: Finding;
  /** Change-folder-relative path. */
  path: string;
}

/** Round numbers that exist for a gate, ascending. */
export async function roundsOf(root: string, change: string, gate: string): Promise<number[]> {
  try {
    return (
      await readdir(join(changeFolder(root, change), "review", gate), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * The rounds that count toward a gate's round limit: every round but one in which no lens
 * reviewed, where each AI lens it was due failed (Claude Code missing, a timeout, a provider
 * outage). Its layer-1 findings run again identically and for free, so such a round used up no
 * review. A round with no AI lens due counts as before.
 */
export async function countedRounds(root: string, change: string, gate: string): Promise<number[]> {
  const out: number[] = [];
  for (const n of await roundsOf(root, change, gate)) {
    const m = await readRoundMeta(root, change, gate, n);
    const due = (m?.lenses ?? []).filter((l) => l.state !== "skipped");
    const nothingReviewed = due.length > 0 && due.every((l) => l.state === "failed");
    if (!nothingReviewed) out.push(n);
  }
  return out;
}

/** The states a person's decision on a finding leaves it in (C3): fixed, waived or dismissed. */
const DECIDED: ReadonlySet<string> = new Set(["applied", "waived", "dismissed"]);

/**
 * Whether a gate whose rounds are used up may have one checking round past its limit (ADR 0115
 * addenda): nothing blocking from its newest counted round is still open (it never had any, or a
 * person acted on every one: applied a fix, waived it with a reason, or dismissed it as not
 * relevant), and a person acted since that round ran: acted on any of its findings (a gap
 * included), not carried from the round before, or answered a question raised for the change.
 * The checking round reviews what was done; if it raises a blocking finding, a person decides
 * again, and a further round needs a further decision. The finding and question ids acted on
 * come back; none when no checking round is due.
 */
export async function checkRoundDue(root: string, change: string, gate: string): Promise<string[]> {
  return (await checkRoundState(root, change, gate)).actedOn;
}

/**
 * What stands between a gate whose rounds are used up and a checking round: the blocking
 * findings of its newest counted round still open, and what a person did since it ran.
 */
export async function checkRoundState(
  root: string,
  change: string,
  gate: string,
): Promise<{ round?: number; openBlocking: number; actedOn: string[] }> {
  const n = (await countedRounds(root, change, gate)).at(-1);
  if (n === undefined) return { openBlocking: 0, actedOn: [] };
  const meta = await readRoundMeta(root, change, gate, n);
  const since = meta?.createdAt ?? "";
  const carried = new Set((meta?.findings ?? []).filter((f) => f.carried).map((f) => f.id));
  const findings = (await readRound(root, change, gate, n)).findings;
  const openBlocking = findings.filter(
    (f) =>
      f.finding.severity === "blocking" && (!DECIDED.has(f.finding.state) || !f.finding.resolution),
  ).length;
  if (openBlocking) return { round: n, openBlocking, actedOn: [] };
  const acted = findings
    .filter(
      (f) =>
        f.finding.resolution &&
        f.finding.state !== "open" &&
        !carried.has(f.finding.id) &&
        f.finding.resolution.at >= since,
    )
    .map((f) => f.finding.id);
  const answered = (await changeAnswers(root, change))
    .filter((a) => a.at >= since)
    .map((a) => a.id);
  return { round: n, openBlocking: 0, actedOn: [...acted.sort(), ...answered.sort()] };
}

/**
 * A knowledge gap a person answered by writing the fact in (edit-and-apply with a reason): their
 * fact holds when the same gap comes back, in a later round or at a later gate (W2).
 */
export const wroteIn = (f: Finding) =>
  f.kind === "knowledge-gap" &&
  f.state === "applied" &&
  f.resolution?.action === "edit-and-apply" &&
  !!f.resolution.reason;

/**
 * Decisions people made at the other gates, by fingerprint (W2): the newest round of each other
 * gate, a finding dismissed or waived with its reason, or a gap a person wrote the fact in for.
 * Carried as C3 carries them within a gate; the reason says where it was decided (once, never
 * stacked). The earliest decision wins.
 */
export async function decidedElsewhere(
  root: string,
  change: string,
  gate: string,
): Promise<Map<string, Finding>> {
  const out = new Map<string, Finding>();
  for (const g of await reviewedGates(root, change)) {
    if (g === gate) continue;
    const round = (await roundsOf(root, change, g)).at(-1);
    if (round === undefined) continue;
    for (const s of (await readRound(root, change, g, round)).findings) {
      const f = s.finding;
      if (!f.resolution || !(["dismissed", "waived"].includes(f.state) || wroteIn(f))) continue;
      const reason = f.resolution.reason;
      const linked = !reason || decidedReason(reason).gate !== undefined;
      const resolution = linked
        ? f.resolution
        : { ...f.resolution, reason: `${reason}${decidedAt(g, s.path)}` };
      const key = fingerprint(f);
      const had = out.get(key);
      if (!had || resolution.at < had.resolution!.at) out.set(key, { ...f, resolution });
    }
  }
  return out;
}

/** Gates that have a review folder. */
export async function reviewedGates(root: string, change: string): Promise<string[]> {
  try {
    return (
      (await readdir(join(changeFolder(root, change), "review"), { withFileTypes: true }))
        // review/defences holds quarantine items (ADR 0042), not a gate's rounds
        .filter((d) => d.isDirectory() && d.name !== "defences")
        .map((d) => d.name)
        .sort()
    );
  } catch {
    return [];
  }
}

/** One lens entry of a round's `meta/round.yaml`. */
export interface RoundLens {
  lens: string;
  agent: string;
  state: "ran" | "skipped" | "failed" | "waiting";
  reason?: string;
  rules: string[];
  artifacts: string[];
  promptSha256?: string;
  /** The hand-off run a waiting (or read-in) lens was with. */
  runId?: string;
}

/** A round's `meta/round.yaml`, as written by the critic (keys it doesn't know are kept). */
export interface RoundMeta extends Record<string, unknown> {
  change: string;
  gate: string;
  round: number;
  createdAt: string;
  findings: { id: string; layer: Layer; rule: string; severity: string; carried?: boolean }[];
  rules: { ran: string[]; skipped: { rule: string; reason: string }[] };
  lenses: RoundLens[];
  discarded: { lens: string; reason: string; summary?: string }[];
}

/** `meta/round.yaml` of one round, or undefined when there is none or it can't be read. */
export async function readRoundMeta(
  root: string,
  change: string,
  gate: string,
  round: number,
): Promise<RoundMeta | undefined> {
  try {
    const text = await readFile(
      join(changeFolder(root, change), "review", gate, String(round), "meta", "round.yaml"),
      "utf8",
    );
    const m = parse(text) as Partial<RoundMeta> | null;
    if (!m || typeof m !== "object") return undefined;
    return {
      ...m,
      findings: m.findings ?? [],
      rules: m.rules ?? { ran: [], skipped: [] },
      lenses: m.lenses ?? [],
      discarded: m.discarded ?? [],
    } as RoundMeta;
  } catch {
    return undefined;
  }
}

/** Every finding file in one round, valid or not. */
export async function readRound(
  root: string,
  change: string,
  gate: string,
  round: number,
): Promise<{ findings: StoredFinding[]; bad: { path: string; message: string }[] }> {
  const dir = join(changeFolder(root, change), "review", gate, String(round));
  let files: string[];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && /\.ya?ml$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return { findings: [], bad: [] };
  }
  const findings: StoredFinding[] = [];
  const bad: { path: string; message: string }[] = [];
  for (const f of files) {
    const rel = `review/${gate}/${round}/${f}`;
    let data: unknown;
    try {
      data = parse(await readFile(join(dir, f), "utf8"));
    } catch (e) {
      bad.push({ path: rel, message: `invalid YAML: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    const r = Finding.safeParse(data);
    if (r.success) findings.push({ finding: r.data, path: rel });
    else bad.push({ path: rel, message: r.error.issues[0]?.message ?? "not a finding" });
  }
  return { findings, bad };
}

/**
 * Owner questions already asked at the other gates and still open there, by fingerprint: the
 * newest round of each other gate, knowledge gaps in state asked. The resolution says who asked
 * and of whom, and its reason links to the first question (an earlier link is kept, not stacked).
 */
export async function askedElsewhere(
  root: string,
  change: string,
  gate: string,
): Promise<Map<string, NonNullable<Finding["resolution"]>>> {
  const out = new Map<string, NonNullable<Finding["resolution"]>>();
  for (const g of await reviewedGates(root, change)) {
    if (g === gate) continue;
    const round = (await roundsOf(root, change, g)).at(-1);
    if (round === undefined) continue;
    for (const s of (await readRound(root, change, g, round)).findings) {
      const f = s.finding;
      if (f.kind !== "knowledge-gap" || f.state !== "asked" || !f.resolution) continue;
      const linked = f.resolution.reason?.startsWith("Already asked at");
      const resolution = linked
        ? f.resolution
        : { ...f.resolution, reason: `Already asked at the ${g} gate: see ${s.path}.` };
      const key = fingerprint(f);
      const had = out.get(key);
      if (!had || resolution.at < had.at) out.set(key, resolution);
    }
  }
  return out;
}
