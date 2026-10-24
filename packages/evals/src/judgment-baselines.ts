/**
 * The heuristics ADR 0117 replaced, frozen here only so the judgment bench can score them
 * against the new judgments on the same cases. No step uses these; they were deleted from the
 * code they lived in (core questions.ts sameQuestion, planner stories.ts namesField and
 * suggestRequests, knowledge grounding.ts STANCE_WORDS and the token-anywhere lead time and date
 * rules, planner gaps.ts reliedOn; and, for the ADR 0117 addendum, release notes.ts breakingOf,
 * plan.ts ROLLBACK, security.ts SECRET_WORDS, naysayer looksPersonal, planner bar.ts dorChecks
 * and knowledge facts.ts VIA_GATEWAY, VIA_DIRECT and DATA_VIA_API). Copied as they were, so the
 * comparison is fair.
 */
import { contentWords } from "@maycombhq/planner";

// ---- core/src/questions.ts sameQuestion (ADR 0089)

const STOP_Q = new Set(
  "a an and are as at be by can do does for from has have in is it its of on or should so that the this these those to was were what when where which who why will with would".split(
    " ",
  ),
);
const contentWordsQ = (s: string, repo: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
      .filter((w) => w.length > 1 && !STOP_Q.has(w) && w !== repo.toLowerCase()),
  );
const kernel = (s: string) =>
  s
    .replace(/\([^)]*\)/g, " ")
    .split(/,\s+or\s+|\s+or\s+/i)[0]!
    .replace(/,[^,]*,/, " ");
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};
export function oldSameQuestion(
  a: { repo: string; question: string; evidence: readonly string[] },
  b: { repo: string; question: string; evidence: readonly string[] },
): boolean {
  if (a.repo !== b.repo) return false;
  const ka = contentWordsQ(kernel(a.question), a.repo);
  const kb = contentWordsQ(kernel(b.question), b.repo);
  const k = jaccard(ka, kb);
  const whole = jaccard(contentWordsQ(a.question, a.repo), contentWordsQ(b.question, b.repo));
  if (a.evidence.some((e) => b.evidence.includes(e)) && Math.max(k, whole) >= 0.25) return true;
  if (Math.min(ka.size, kb.size) >= 3 && k >= 0.75) return true;
  return whole >= 0.7;
}

// ---- planner/src/stages/stories.ts namesField

export function oldNamesField(criterion: string, field: string): boolean {
  const lower = criterion.toLowerCase();
  if (lower.includes(field.toLowerCase())) return true;
  const words = field
    .split(".")
    .at(-1)!
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
  if (!words.length) return false;
  const said = new Set(lower.split(/[^a-z0-9]+/));
  return words.every((w) => said.has(w));
}

// ---- knowledge/src/grounding.ts (lead_time, status, dates), before ADR 0117

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
function tokens(text: string): string[] {
  const raw = (
    text
      .toLowerCase()
      .replace(/[‘’‛′]/g, "'")
      .match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
  ).map((w) => w.replace(/^(\d+)(st|nd|rd|th)$/, "$1"));
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]!;
    const next = raw[i + 1];
    if (TENS[w] !== undefined && next && UNITS[next] !== undefined && UNITS[next]! < 10) {
      out.push(String(TENS[w]! + UNITS[next]!));
      i++;
    } else if (UNITS[w] !== undefined) out.push(String(UNITS[w]));
    else if (TENS[w] !== undefined) out.push(String(TENS[w]));
    else out.push(w.replace(/^(minute|hour|day|week|month|year)s$/, "$1"));
  }
  return out;
}
const FILLER = new Set(
  "a an the of in within about around up to at least most approximately roughly for from by allow".split(
    " ",
  ),
);
const STANCE: Record<string, string[]> = {
  mandated: [
    "must",
    "shall",
    "required",
    "requires",
    "require",
    "mandatory",
    "mandated",
    "always",
    "only",
    "every",
  ],
  banned: [
    "banned",
    "ban",
    "never",
    "must not",
    "may not",
    "cannot",
    "can not",
    "not allowed",
    "not permitted",
    "forbidden",
    "prohibited",
    "do not",
    "don't",
    "no",
  ],
  retiring: [
    "retiring",
    "retire",
    "retired",
    "retirement",
    "retires",
    "deprecated",
    "deprecate",
    "sunset",
    "decommission",
    "decommissioned",
    "switched off",
    "switch off",
    "switches off",
    "phase out",
    "phased out",
    "end of life",
    "withdrawn",
    "replaced",
    "replaces",
  ],
};
const MONTHS =
  "january february march april may june july august september october november december".split(
    " ",
  );
const hasRun = (t: string[], run: string[]) => {
  for (let i = 0; i + run.length <= t.length; i++)
    if (run.every((w, k) => t[i + k] === w)) return true;
  return false;
};
/** Whether the old rule passed a value against a quote. */
export function oldStatesValue(field: string, value: string, quote: string): boolean {
  const t = tokens(quote);
  if (field === "lead_time")
    return tokens(value)
      .filter((x) => !FILLER.has(x))
      .every((x) => t.includes(x));
  if (field === "status") return (STANCE[value] ?? []).map(tokens).some((w) => hasRun(t, w));
  if (field.startsWith("dates.")) {
    if (quote.includes(value)) return true;
    const d = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
    if (!d) return tokens(value).every((x) => t.includes(x));
    const month = MONTHS[Number(d[2]) - 1]!;
    const named = t.includes(month) || t.includes(month.slice(0, 3));
    const day = d[3] === undefined || t.includes(String(Number(d[3])));
    return named && day && t.includes(d[1]!);
  }
  return false;
}

// ---- planner/src/needs.ts leadTimeDays (a lead time's working days, from its words)

export function oldLeadTimeDays(leadTime: string): number | undefined {
  const t = tokens(leadTime);
  const per: Record<string, number> = { hour: 1 / 8, day: 1, week: 5, month: 21, year: 250 };
  let best: number | undefined;
  for (let i = 0; i < t.length; i++) {
    const unit = per[t[i]!];
    if (unit === undefined) continue;
    const nums = t
      .slice(Math.max(0, i - 4), i)
      .filter((x) => /^\d+$/.test(x))
      .map(Number);
    if (!nums.length) continue;
    const working = t[i - 1] === "working" || t[i - 1] === "business";
    const days = Math.max(...nums) * (t[i] === "day" && !working ? 5 / 7 : unit);
    best = Math.max(best ?? 0, Math.ceil(days));
  }
  return best && best > 0 ? best : undefined;
}

// ---- planner/src/stages/stories.ts suggestRequests (two shared words)

const WEAK = new Set(contentWords("new change service system data make step flow"));
export interface OldStep {
  kind: string;
  what: string;
  vendor?: boolean;
  newTarget?: boolean;
  newTable?: boolean;
  newColumn?: boolean;
}
export function oldApplies(step: OldStep, p: { title: string; appliesWhen: string }): boolean {
  const extra: string[] = [];
  if (step.kind === "call-out") extra.push("call", "reach", "outbound", "send");
  if (step.kind === "publish")
    extra.push("publish", "event", "topic", "queue", "message", "broker");
  if (step.kind === "write") extra.push("write", "store", "stores", "table");
  if (step.vendor)
    extra.push(
      "vendor",
      "external",
      "partner",
      "third-party",
      "outside",
      "host",
      "network",
      "internet",
    );
  if (step.newTarget) extra.push("new");
  if (step.newTable) extra.push("new", "table");
  if (step.newColumn) extra.push("new", "column", "columns");
  const have = new Set(contentWords(`${step.what} ${extra.join(" ")}`));
  const want = contentWords(`${p.appliesWhen} ${p.title}`).filter((w) => !WEAK.has(w));
  return want.filter((w) => have.has(w)).length >= 2;
}

// ---- planner/src/gaps.ts reliedOn (the name anywhere in the answer)

export const oldReliesOn = (gap: string, answer: string) =>
  answer.toLowerCase().replace(/\s+/g, " ").includes(gap.toLowerCase().replace(/\s+/g, " "));

// ---- the ADR 0117 addendum's replaced rules, as they were

// release/src/notes.ts breakingOf: "yes", "no" or "check" (check counts as not yes)
const OLD_BREAKING =
  /\b(remov(e|es|ed|ing)|renam(e|es|ed|ing)|no longer|now required|becomes required|drop(s|ped)?|retir(e|es|ed))\b/i;
const OLD_NEW_ERROR = /\b(error|status|http \d{3}|\d{3}\))/i;
const OLD_ADDITIVE = /\b(gains?|adds?|new optional|optional)\b/i;
export function oldBreaking(change: string, notes: string): "yes" | "no" | "check" {
  if (change === "planned-retire") return "yes";
  if (change === "planned-new") return "no";
  if (OLD_BREAKING.test(notes)) return "yes";
  if (OLD_NEW_ERROR.test(notes)) return "check";
  if (OLD_ADDITIVE.test(notes)) return "no";
  return "check";
}

// release/src/plan.ts ROLLBACK and rollbackOf, for one sentence and one step
const OLD_ROLLBACK =
  /\b(roll(?:ed|ing)?[ -]?back|revert(?:ed|ing)?|back[ -]?out|undo|down[ -]?migration|restore)\b/i;
const oldHasWord = (text: string, word: string) =>
  new RegExp(
    `(^|[^A-Za-z0-9_-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
    "i",
  ).test(text);
export function oldUndoes(
  sentence: string,
  step: { kind: string; names: string[] },
  others: string[],
): boolean {
  if (!OLD_ROLLBACK.test(sentence)) return false;
  if (step.names.some((n) => oldHasWord(sentence, n))) return true;
  if (others.some((n) => oldHasWord(sentence, n))) return false;
  const dataWords = /migration|schema|column|table/i.test(sentence);
  return step.kind === "migration" ? dataWords : step.kind === "code" ? !dataWords : false;
}

// release/src/security.ts SECRET_WORDS
const OLD_SECRET_WORDS =
  /\b(secret|shared key|api key|private key|certificate|credential|password|token|vault|keystore|signing key)s?\b/i;
export const oldNamesSecret = (line: string) => OLD_SECRET_WORDS.test(line);

// naysayer/src/checks/data.ts looksPersonal (and PERSONAL_PARTS)
const OLD_PERSONAL_PARTS = [
  "email",
  "mail",
  "phone",
  "mobile",
  "name",
  "firstname",
  "lastname",
  "surname",
  "address",
  "street",
  "postcode",
  "zip",
  "birth",
  "dob",
  "ssn",
  "passport",
  "national",
  "iban",
  "ip",
];
export const oldLooksPersonal = (column: string) =>
  column
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((p) => OLD_PERSONAL_PARTS.includes(p));

// planner/src/bar.ts dorChecks
export function oldDorChecks(item: string): string[] {
  const k = item.toLowerCase();
  const out: string[] = [];
  if (/\bwho\b|for whom|\buser\b|outcome|value|brief|trace/.test(k)) out.push("who", "traced");
  if (/acceptance|given|criteria/.test(k)) out.push("criteria");
  if (/system|repo/.test(k)) out.push("systems");
  if (/depend/.test(k)) out.push("depends");
  if (/\btest/.test(k)) out.push("tests");
  return out;
}

// knowledge/src/facts.ts DATA_VIA_API, VIA_GATEWAY and VIA_DIRECT, in the order mapFacts read them
const OLD_DATA_VIA_API =
  /\b(?:reads?|quer(?:y|ies)|fetch(?:es)?|gets?|loads?)\b\s+(.*?)\s*\bthrough the\s+(.+?)\s+API\b/i;
const OLD_VIA_GATEWAY = /\b(?:through|via) the (?:api )?gateway\b/i;
const OLD_VIA_DIRECT = /\bdirect(?:ly)?\b/i;
export function oldReaches(sentence: string): "gateway" | "direct" | "api-only" | "none" {
  if (OLD_DATA_VIA_API.test(sentence)) return "api-only";
  if (OLD_VIA_GATEWAY.test(sentence)) return "gateway";
  if (OLD_VIA_DIRECT.test(sentence)) return "direct";
  return "none";
}
