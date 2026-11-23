import { z } from "zod";
import type { AuditTally } from "./audit.js";
import {
  HOSTS_NONE,
  HOSTS_STEP,
  JOIN_IGNORE_LABEL,
  outsideBoundaryOf,
  PICKER_LABELS,
  TARGETS_SPLIT_LABEL,
  TARGETS_STEP_ID,
  TOPICS_STEP_ID,
} from "./host-questions.js";
import { normalizePath } from "./identity.js";
import type { DecideSettings } from "./schema/orgpack.js";
import {
  AiBy,
  AppliedRule,
  BatchId,
  QuestionAnswer,
  QuestionId,
  type DecideBar,
  type Question,
} from "./schema/question.js";
import { hostMatches } from "./schema/workspace.js";

/**
 * ADR 0181: AI decides first, people correct, and a correction spreads. The pure parts: what the
 * AI may decide, the bar a decision must meet to be applied without a person, the rule a
 * person's correction spreads (as ADR 0153's `--match`: a path prefix, a host or a topic
 * pattern), the batch record that makes every application one Undo away, and the pause when the
 * sample audit (ADR 0148) puts the AI's decisions below the organisation's bar.
 *
 * An AI decision is a third kind of answer, beside a fact verified from code and a person's word:
 * Atticus writes it (never the session), as the AI's, with the run that made it.
 */

/**
 * What a pairing's shapes say (ADR 0178): its call's one best API (`suggestion`, left out when two
 * are as likely as each other) and whether it is confident.
 */
export interface ShapesOfCall {
  suggestion?: { api: string; score: number } | undefined;
  confident?: boolean | undefined;
}

/**
 * The bar an AI pairing of a call with `api` meets (ADR 0181, part 1), or undefined when it meets
 * none and stays a proposal. `confident`: the shapes rank the same API first, at 0.85 or more and
 * 0.2 ahead of the next (ADR 0178); `agrees-with-shapes`: the shapes rank it first, alone;
 * `person-rule`: a person's rule covers the call and names the same box. The citation check is
 * the caller's.
 */
export function pairingBar(
  call: ShapesOfCall,
  api: string,
  o: { ruleAgrees?: boolean } = {},
): DecideBar | undefined {
  // A tie at the top is no suggestion (ADR 0174): the AI's pick then agrees with nothing.
  const best = call.suggestion;
  if (best?.api === api) return call.confident ? "confident" : "agrees-with-shapes";
  return o.ruleAgrees ? "person-rule" : undefined;
}

/**
 * Why the AI may not decide this question with this option, or undefined when it may (ADR 0181):
 * only an open question about where a call goes (a target or a system on file), at its repo's
 * scope, and only an option that names one place. Never words (a free-text question), a scope
 * wider than the repo, a hosts answer (it writes the repos manifest for every caller) or a topics
 * answer (it changes the org pack's profile), the picker, "Not all to one place" or "None of these".
 */
export function questionAiProblem(q: Question, option: number | undefined): string | undefined {
  if (q.state !== "open") return `it is ${q.state}; the AI decides only an open question`;
  if (q.askedBy.step === HOSTS_STEP)
    return "a hosts answer writes the repos manifest for every caller of the host: a person answers it";
  if (q.askedBy.step === TOPICS_STEP_ID)
    return "a topics answer changes the org pack's profile: a person answers it";
  if (!q.options.length)
    return "it asks for a person's own words (a free-text question): a person answers it";
  if (q.askedBy.step !== TARGETS_STEP_ID)
    return "only a question about where a call goes is the AI's to decide";
  if (q.scope.level !== "repo")
    return "its scope is wider than the repo (a repo type): a person answers it";
  if (option === undefined || !Number.isInteger(option) || option < 1 || option > q.options.length)
    return `pick one of its ${q.options.length} options`;
  const label = q.options[option - 1]!.label;
  if (PICKER_LABELS.has(label)) return `"${label}" opens the picker and names nothing`;
  if (label === TARGETS_SPLIT_LABEL)
    return `"${label}" says the calls go to more than one place: a person says so`;
  if (label === HOSTS_NONE) return `"${label}" says none answers: a person says so`;
  if (label === JOIN_IGNORE_LABEL) return `"${label}" says the calls aren't real: a person says so`;
  // Beta.24 review: a new outside system goes into the org pack's profile: a person adds it.
  if (outsideBoundaryOf(label))
    return `"${label}" adds a system to the org pack's profile: a person answers it`;
  return undefined;
}

/**
 * The bar an AI answer meets (ADR 0181), or undefined: `agrees-with-shapes` when the option is the
 * one the shapes rank first (a targets question lists its suggestions best first, each with the
 * lines that give it), `person-rule` when a person's rule covers the question and names the same.
 * The citation check (the proposal's lines, ADR 0144) is the caller's.
 */
export function questionBar(
  q: Question,
  option: number,
  o: { shapesFirst: boolean; ruleAgrees?: boolean },
): DecideBar | undefined {
  if (questionAiProblem(q, option)) return undefined;
  if (o.shapesFirst) return "agrees-with-shapes";
  return o.ruleAgrees ? "person-rule" : undefined;
}

// ------------------------------------------------------------------ a correction's rule

/** What a rule is matched against: a call's path, the host it calls, or its topic. */
export interface RuleSubject {
  path?: string | undefined;
  host?: string | undefined;
  topic?: string | undefined;
}

export type RuleKind = "path" | "host" | "topic";

const isPlaceholder = (s: string) => s === "{}";
const segmentsOf = (p: string) =>
  normalizePath(p.startsWith("/") ? p : `/${p}`)
    .split("/")
    .filter(Boolean);
const lcp = <T>(a: readonly T[], b: readonly T[]) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
};
/** The longest of some prefixes (the first of equals), or undefined when there are none. */
const longest = <T>(xs: readonly (readonly T[])[]): T[] | undefined =>
  xs.length ? [...xs.reduce((a, b) => (b.length > a.length ? b : a))] : undefined;
/** Up to the first placeholder: a rule names fixed segments only. */
const fixed = (segs: readonly string[]) => {
  const i = segs.findIndex(isPlaceholder);
  return i < 0 ? [...segs] : segs.slice(0, i);
};

/**
 * The rule a person's correction spreads (ADR 0181, part 2): the path prefix, host pattern or
 * topic pattern the corrected item shares with its siblings (the other items the AI decided the
 * same way), as ADR 0153's `--match` takes it. Without a sibling sharing more, the corrected item's
 * own folder (`/forge/limits/{id}` → `/forge/limits/**`), its host's parent domain, or its topic's
 * family. Shown to the person before anything is saved; they may change it.
 *
 * Review round 48: the longest prefix shared with at least one sibling, not the prefix all the
 * siblings share, so one distant sibling never widens `/api/v1/limits/**` to `/api/v1/**`; and a
 * shared path of two segments or fewer that is wider than the item's own folder is too wide (as
 * `/**` is): the item's own folder is taken instead.
 */
export function deriveMatch(
  item: RuleSubject,
  siblings: readonly RuleSubject[],
): { kind: RuleKind; match: string } {
  if (item.topic) {
    const own = item.topic.split(".");
    const parent = own.length > 1 ? own.slice(0, -1) : own;
    const shared = siblings
      .map((s) => (s.topic ? lcp(own, s.topic.split(".")) : []))
      .filter((x) => x.length >= Math.max(1, parent.length - 1) && x.length < own.length);
    const common = longest(shared) ?? parent;
    const use = common.length ? common : parent;
    return { kind: "topic", match: use.length < own.length ? `${use.join(".")}.*` : item.topic };
  }
  if (item.host && !item.path?.startsWith("/")) {
    const own = item.host.toLowerCase().split(".").reverse();
    const parent = own.length > 2 ? own.slice(0, -1) : own;
    const shared = siblings
      .map((s) => (s.host ? lcp(own, s.host.toLowerCase().split(".").reverse()) : []))
      .filter((x) => x.length >= 2 && x.length < own.length);
    const common = longest(shared) ?? parent;
    const use = common.length >= 2 ? common : parent;
    return {
      kind: "host",
      match: use.length < own.length ? `*.${[...use].reverse().join(".")}` : item.host,
    };
  }
  const own = segmentsOf(item.path ?? "/");
  const parent = fixed(own.slice(0, -1));
  const shared = siblings
    .map((s) => (s.path ? fixed(lcp(own, segmentsOf(s.path))) : []))
    .filter((x) => x.length >= 2);
  let use = longest(shared) ?? parent;
  if (use.length <= 2 && use.length < parent.length) use = parent;
  if (use.length < 2 && parent.length >= 2) use = parent;
  return { kind: "path", match: use.length ? `/${use.join("/")}/**` : "/**" };
}

/** Whether a rule (a path prefix, a host pattern or a topic pattern) covers an item. */
export function matchCovers(match: string, item: RuleSubject): boolean {
  const m = match.trim();
  if (m.startsWith("/")) {
    if (!item.path) return false;
    if (m === "/**") return true;
    const want = segmentsOf(m.replace(/\/\*\*$/, ""));
    const have = segmentsOf(item.path);
    if (have.length < want.length) return false;
    return want.every((w, i) => isPlaceholder(w) || w === have[i]);
  }
  if (item.topic) {
    const want = m.split(".");
    const have = item.topic.split(".");
    if (want.at(-1) === "*") {
      const head = want.slice(0, -1);
      if (have.length <= head.length) return false;
      return head.every((w, i) => w === "*" || w === have[i]);
    }
    return want.length === have.length && want.every((w, i) => w === "*" || w === have[i]);
  }
  if (item.host) {
    const [name, port] = item.host.split(/:(?=\d+$)/);
    return hostMatches(m, name!, port ? Number(port) : undefined);
  }
  return false;
}

/** The kind of a rule, from its words. */
export const ruleKindOf = (match: string, item?: RuleSubject): RuleKind =>
  match.startsWith("/") ? "path" : item?.topic ? "topic" : "host";

// ------------------------------------------------------------------ batches

/**
 * A batch's id: `b-<yyyymmdd>-<hhmmss>-<6 hex>`, the time in UTC and a random part, so two batches
 * in the same second are told apart.
 */
export function newBatchId(now: Date, rand: () => number = Math.random): string {
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  const hex = Math.floor(rand() * 0xffffff)
    .toString(16)
    .padStart(6, "0")
    .slice(-6);
  return `b-${day}-${time}-${hex}`;
}

/** A pairing line a batch wrote or took away, exactly as it is in the repo's corrections file. */
export const BatchLink = z.strictObject({
  kind: z.literal("link"),
  repo: z.string().min(1),
  fact: z.string().min(1),
  line: z.string().min(2),
});
/**
 * A question a batch answered or opened again, with the answer it had before (none when open).
 * Review round 48 (additive): for an AI answer taken up from a proposal, the proposal file's text
 * as it was (`proposal`), so Undo puts it back for a person to review.
 */
export const BatchQuestion = z.strictObject({
  kind: z.literal("question"),
  id: QuestionId,
  before: QuestionAnswer.optional(),
  proposal: z.string().min(1).max(65536).optional(),
});
export const BatchItem = z.discriminatedUnion("kind", [BatchLink, BatchQuestion]);
export type BatchItemT = z.infer<typeof BatchItem>;

/**
 * ADR 0181: the record of one batch: decisions the AI applied from one run (`ai`), or a person's
 * correction and what its rule applied (`rule`). `applied` are the lines it appended and the
 * answers it wrote; `reverted` the AI lines it took away and the AI answers it opened again, kept
 * so Undo puts them back. Undo removes exactly the batch's own lines and answers, never a later
 * one, and records who undid it and when. A file per batch under `decisions/`, committed in the
 * pull request with the lines it names.
 */
export const DecisionBatch = z.strictObject({
  schema: z.literal(1),
  id: BatchId,
  kind: z.enum(["ai", "rule"]),
  at: z.iso.datetime({ offset: true }),
  /** The AI and its run, for an AI batch; the person, for a correction and its rule. */
  by: z.union([z.string().min(1), AiBy]),
  /** For a correction: what was corrected, the answer the person gave and the rule spread. */
  correction: z
    .strictObject({
      item: z.string().min(1),
      /** The repo, system or option label the person picked; "none" for none of these. */
      answer: z.string().min(1),
      rule: AppliedRule.extend({ kind: z.enum(["path", "host", "topic"]) }).optional(),
      /** The run of the AI decision the person corrected. */
      run: z.string().min(1).optional(),
      /** What the corrected shape is, so a shape corrected again and again becomes a reading rule. */
      shape: z.string().min(1).optional(),
    })
    .optional(),
  applied: z.array(BatchItem),
  reverted: z.array(BatchItem),
  undone: z
    .strictObject({ by: z.string().min(1), at: z.iso.datetime({ offset: true }) })
    .optional(),
});
export type DecisionBatchT = z.infer<typeof DecisionBatch>;

/** ADR 0181: corrections of the same shape that make a reading rule worth proposing (ADR 0176). */
export const RULE_AFTER_CORRECTIONS = 3;

// ------------------------------------------------------------------ the pause

export interface DecideNow {
  links: "auto" | "propose";
  questions: "auto" | "propose";
  /** Deciding is paused back to propose: why, in words Home shows, and the audit's numbers. */
  paused?: {
    why: string;
    precision: number;
    low: number | null;
    high: number | null;
    answered: number;
    minPrecision: number;
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * Whether the AI decides now (ADR 0181, part 3): as runtime.yaml's `decide` says, unless the
 * sample audit of the AI's decisions (ADR 0148, the AI kind) puts them right less often than
 * `decide.minPrecision`; then both go back to propose and `paused` says why. With nothing audited
 * yet, as configured.
 */
export function aiPause(settings: DecideSettings, tally: AuditTally | undefined): DecideNow {
  const on = { links: settings.links, questions: settings.questions };
  const n = (tally?.right ?? 0) + (tally?.wrong ?? 0);
  if (!tally || !n || tally.precision === null || tally.precision >= settings.minPrecision)
    return on;
  if (settings.links === "propose" && settings.questions === "propose") return on;
  return {
    links: "propose",
    questions: "propose",
    paused: {
      why: `The sample audit puts the AI's decisions at ${pct(tally.precision)} right (${tally.right} of ${n} audited), below the ${pct(settings.minPrecision)} runtime.yaml asks for (decide.minPrecision): the AI proposes again, for a person to confirm, until more audited decisions are right or the bar changes.`,
      precision: tally.precision,
      low: tally.low,
      high: tally.high,
      answered: n,
      minPrecision: settings.minPrecision,
    },
  };
}
