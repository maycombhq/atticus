import { z } from "zod";
import { parse, stringify } from "yaml";
import type { Fact } from "./schema/facts.js";

/**
 * The sample audit (plan item P3, ADR 0148): a person confirms a handful of a repo's kept facts
 * and of the links the estate join makes from it, drawn at random but reproducibly from a seed,
 * and the answers give a precision on the real estate. The answers are a person's record,
 * `<repo>.audit.yaml` beside the facts, committed in a pull request like any other file of the
 * metarepo; nothing is sent anywhere.
 *
 * The verifier never takes an audit's word into the facts file (a reader can't vouch for itself,
 * and `atticus verify` writes `verified: line` on every fact a reader made): a right answer shows
 * as `verified: sample` where the facts are read for a person (the Map's facts list), as long as
 * the fact still cites the line the person saw. Pure: the caller reads and writes the file.
 */

export const AUDIT_ANSWERS = ["right", "wrong", "unsure"] as const;
export type AuditAnswer = (typeof AUDIT_ANSWERS)[number];

export const AuditItem = z.strictObject({
  /** `fact:<fact id>`, or `link:<call fact id>` (with `~<entry fact id>` when a call joins several). */
  id: z.string().min(1),
  kind: z.enum(["fact", "link"]),
  /** A fact's kind (entry, call, store...), or how a link was joined (`joined-by-host`...). */
  of: z.string().min(1),
  /** What the item says, in one line. */
  claim: z.string().min(1),
  /** The lines it rests on: `file:line` for a fact, `<repo> file:line` for a link's ends and hops. */
  cites: z.array(z.string().min(1)).min(1),
  /** The fact (for a link, the call fact) the item is of. */
  fact: z.string().optional(),
  /** A fact's claimed value as cited, so a fact read again with another claim is told apart. */
  value: z.string().optional(),
  /** A link's callee repo. */
  to: z.string().optional(),
  answer: z.enum(AUDIT_ANSWERS).optional(),
  note: z.string().optional(),
  /** Who answered, and when. */
  by: z.string().optional(),
  at: z.string().optional(),
});
export type AuditItemT = z.infer<typeof AuditItem>;

export const AuditDraw = z.strictObject({
  seed: z.string().min(1),
  size: z.number().int().positive(),
  commit: z.string().optional(),
  at: z.string(),
});
export type AuditDrawT = z.infer<typeof AuditDraw>;

export const AuditFile = z.strictObject({
  schema: z.literal(1),
  repo: z.string().min(1),
  draws: z.array(AuditDraw),
  items: z.array(AuditItem),
});
export type AuditFileT = z.infer<typeof AuditFile>;

export const AUDIT_DEFAULT_SIZE = 10;

export function parseAuditFile(
  text: string,
): { ok: true; file: AuditFileT } | { ok: false; issues: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, issues: [`not YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  const r = AuditFile.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  return { ok: true, file: r.data };
}

export function serializeAuditFile(file: AuditFileT): string {
  return stringify(AuditFile.parse(file), { lineWidth: 0 });
}

const what = (f: Fact): string => {
  const x = f as unknown as Record<string, string | undefined>;
  switch (f.kind) {
    case "entry":
    case "call":
      return [x.method?.toUpperCase(), x.path].filter(Boolean).join(" ");
    case "store":
      return `${x.op} ${x.name} in ${x.store}`;
    case "field":
      return `${x.name}${x.owner ? ` of ${x.owner}` : ""}`;
    case "config":
      return `${x.key} = ${x.value ?? ""}`.trim();
    case "framework":
      return `${x.name}${x.version ? ` ${x.version}` : ""}`;
    case "flow":
      return x.name ?? f.id;
    default:
      return f.cite.value;
  }
};

/**
 * The facts an audit may draw: those the verifier kept that a reader wrote. A person's own fact
 * (a correction) is their word already, and one not yet checked isn't kept; neither is drawn.
 */
export function auditCandidates(facts: readonly Fact[]): AuditItemT[] {
  return facts
    .filter((f) => f.verified !== "none" && f.by !== "person")
    .map((f) => ({
      id: `fact:${f.id}`,
      kind: "fact" as const,
      of: f.kind,
      claim: `${f.kind} ${what(f)}`.trim(),
      cites: [
        `${f.cite.file}:${f.cite.line}`,
        ...(f.cite.with ?? []).map((w) => `${w.file}:${w.line}`),
      ],
      fact: f.id,
      value: f.cite.value,
    }));
}

/** FNV-1a, then mulberry32: a small seeded generator, the same on every machine. */
function generator(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T extends { id: string }>(list: readonly T[], seed: string): T[] {
  const out = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = generator(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A reproducible random sample: `size` facts and `size` links (all of them when there are
 * fewer), the same for the same candidates and seed whatever order they come in.
 */
export function drawAudit(o: {
  facts: readonly AuditItemT[];
  links: readonly AuditItemT[];
  size: number;
  seed: string;
}): AuditItemT[] {
  return [
    ...shuffled(o.facts, `${o.seed}:facts`).slice(0, o.size),
    ...shuffled(o.links, `${o.seed}:links`).slice(0, o.size),
  ];
}

/**
 * A draw added to the file on record: items already there keep their answers, new ones are
 * added unanswered, and a draw with the same seed, size and commit isn't recorded twice.
 */
export function mergeDraw(
  file: AuditFileT | undefined,
  repo: string,
  items: readonly AuditItemT[],
  draw: AuditDrawT,
): AuditFileT {
  const out: AuditFileT = file
    ? { ...file, draws: [...file.draws], items: [...file.items] }
    : { schema: 1, repo, draws: [], items: [] };
  if (
    !out.draws.some((d) => d.seed === draw.seed && d.size === draw.size && d.commit === draw.commit)
  )
    out.draws.push(draw);
  const have = new Set(out.items.map((i) => i.id));
  for (const i of items) if (!have.has(i.id)) out.items.push({ ...i });
  return out;
}

/**
 * The Wilson score interval at 95%, rounded to three places: honest for a small sample and for
 * a precision of 0 or 1, where the plain p ± 2σ is not. Undefined with nothing answered.
 */
export function wilson(right: number, n: number): { low: number; high: number } | undefined {
  if (n <= 0) return undefined;
  const z = 1.96;
  const p = right / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const r = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
  return { low: r(centre - margin), high: r(centre + margin) };
}

export interface AuditTally {
  drawn: number;
  right: number;
  wrong: number;
  unsure: number;
  /** Drawn and not answered yet. */
  open: number;
  /** Drawn, but the fact or link is no longer as the person saw it: left out of the count. */
  gone: number;
  /** right / (right + wrong); null with neither. */
  precision: number | null;
  low: number | null;
  high: number | null;
}

export interface AuditPrecision {
  facts: AuditTally;
  byKind: Record<string, AuditTally>;
  links: AuditTally;
  /** Links by how they were joined (ADR 0135's flags). */
  byHow: Record<string, AuditTally>;
}

const empty = (): AuditTally => ({
  drawn: 0,
  right: 0,
  wrong: 0,
  unsure: 0,
  open: 0,
  gone: 0,
  precision: null,
  low: null,
  high: null,
});

function finish(t: AuditTally): AuditTally {
  const n = t.right + t.wrong;
  const ci = wilson(t.right, n);
  return {
    ...t,
    precision: n ? Math.round((t.right / n) * 1000) / 1000 : null,
    low: ci?.low ?? null,
    high: ci?.high ?? null,
  };
}

/**
 * Precision from the answers: of the items answered right or wrong, the share right, with the
 * Wilson interval. Unsure and unanswered items are counted apart and never in the share; `keep`
 * drops an item whose fact or link has changed since it was drawn (counted as gone).
 */
export function auditPrecision(
  items: readonly AuditItemT[],
  keep: (i: AuditItemT) => boolean = () => true,
): AuditPrecision {
  const facts = empty();
  const links = empty();
  const byKind: Record<string, AuditTally> = {};
  const byHow: Record<string, AuditTally> = {};
  for (const i of items) {
    const groups =
      i.kind === "fact" ? [facts, (byKind[i.of] ??= empty())] : [links, (byHow[i.of] ??= empty())];
    for (const g of groups) {
      g.drawn++;
      if (!keep(i)) g.gone++;
      else if (!i.answer) g.open++;
      else g[i.answer]++;
    }
  }
  const all = (r: Record<string, AuditTally>) =>
    Object.fromEntries(
      Object.entries(r)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, t]) => [k, finish(t)]),
    );
  return { facts: finish(facts), byKind: all(byKind), links: finish(links), byHow: all(byHow) };
}

/** Several repos' precision summed: the estate's. */
export function sumAuditPrecision(list: readonly AuditPrecision[]): AuditPrecision {
  const add = (a: AuditTally, b: AuditTally): AuditTally => ({
    ...a,
    drawn: a.drawn + b.drawn,
    right: a.right + b.right,
    wrong: a.wrong + b.wrong,
    unsure: a.unsure + b.unsure,
    open: a.open + b.open,
    gone: a.gone + b.gone,
  });
  const merge = (rs: Record<string, AuditTally>[]) => {
    const out: Record<string, AuditTally> = {};
    for (const r of rs) for (const [k, t] of Object.entries(r)) out[k] = add(out[k] ?? empty(), t);
    return Object.fromEntries(
      Object.entries(out)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, t]) => [k, finish(t)]),
    );
  };
  return {
    facts: finish(list.reduce((a, p) => add(a, p.facts), empty())),
    links: finish(list.reduce((a, p) => add(a, p.links), empty())),
    byKind: merge(list.map((p) => p.byKind)),
    byHow: merge(list.map((p) => p.byHow)),
  };
}

/**
 * Whether a fact item is still the fact the person saw: the same id, citing the same line with
 * the same value. Used to keep an answer standing, and to show a right one as `verified: sample`.
 */
export function auditItemHolds(i: AuditItemT, facts: ReadonlyMap<string, Fact>): boolean {
  if (i.kind !== "fact" || !i.fact) return true;
  const f = facts.get(i.fact);
  if (!f) return false;
  return (
    i.cites[0] === `${f.cite.file}:${f.cite.line}` &&
    (i.value === undefined || i.value === f.cite.value)
  );
}

/**
 * The facts a person answered right in a sample audit that are still as they saw them: shown as
 * `verified: sample` where the facts are read for a person (the facts file keeps `line`).
 */
export function sampleConfirmed(
  audit: AuditFileT | undefined,
  facts: readonly Fact[],
): Set<string> {
  const byId = new Map(facts.map((f) => [f.id, f] as const));
  return new Set(
    (audit?.items ?? [])
      .filter((i) => i.kind === "fact" && i.answer === "right" && i.fact && auditItemHolds(i, byId))
      .map((i) => i.fact!),
  );
}
