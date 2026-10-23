/**
 * Values tied to the words they cite (ADR 0111). A knowledge item's quote is checked word for
 * word on its page (ADR 0083); this checks that what the item states as a value is in that
 * quote too: its lead time, its dates, who handles or owns it, and its status. A value no quote
 * states is handed back to the model, like a quote that isn't on its page. Deterministic, no AI.
 *
 * The rule, exactly:
 * - Text is folded to tokens: lower case, runs of letters or digits; an ordinal ("1st") is its
 *   number; the number words zero to twenty, the tens to ninety, and a tens-unit pair joined by a
 *   hyphen or a space ("twenty-one") are digits; the time units minute, hour, day, week, month and
 *   year lose a plural "s". Nothing else is forgiven: "working days" is not "business days", and
 *   "days" is not "working days".
 * - lead_time: each of its tokens, apart from the filler words listed in FILLER, is a token of one
 *   of the item's quotes (its source quote and its also_on quotes).
 * - handled_by and owned_by: its tokens ("the" in front left out) are a run of tokens in one
 *   quote, or the name is the page's own owner (its front matter's `owner`).
 * - dates: each date (YYYY-MM-DD) is in one quote as written, or as its day, its month's name (or
 *   the name's first three letters) and its year, in any order; a month (YYYY-MM) as the month's
 *   name and year. A value that isn't a date needs its tokens in one quote.
 * - status: one quote holds a word for it (STANCE_WORDS): banned needs a ban, mandated a
 *   mandate, retiring a retirement.
 * - rules, applies_when, inputs and steps are the model's summary of a section, so their words
 *   aren't checked; each number they state (a run of digits) is on one of the item's pages.
 */

export interface Grounding {
  /** The item's quotes: its source quote and its also_on quotes, each already on its page. */
  quotes: string[];
  /** The visible text of every page the item quotes. */
  pages: string;
  /** The front matter's owner of the page the source quote is on. */
  owner?: string;
}

/** The fields of an item this checks; any other field is left alone. */
export interface Valued {
  lead_time?: string | undefined;
  handled_by?: string | undefined;
  owned_by?: string | undefined;
  status?: string | undefined;
  dates?: Record<string, string> | undefined;
  rules?: string[];
  applies_when?: string | undefined;
  inputs?: string[];
  steps?: string[];
}

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
const TIME_UNIT = /^(minute|hour|day|week|month|year)s$/;

/** Words a lead time may carry that the page needn't repeat. */
const FILLER = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "within",
  "about",
  "around",
  "up",
  "to",
  "at",
  "least",
  "most",
  "approximately",
  "roughly",
  "for",
  "from",
  "by",
  "allow",
]);

/** The words that state each status, as tokens or token runs. */
export const STANCE_WORDS: Record<string, string[]> = {
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
/** The words the hand-back message names for each status. */
const STANCE_HINT: Record<string, string> = {
  mandated: "must, shall, required or mandatory",
  banned: "banned, never, must not, not allowed or prohibited",
  retiring: "retiring, deprecated, decommissioned or switched off",
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Text as the check compares it: tokens, folded as the rule above says. */
export function valueTokens(text: string): string[] {
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
    else out.push(w.replace(TIME_UNIT, "$1"));
  }
  return out;
}

/** Whether `run` is a run of tokens in `tokens`. */
const hasRun = (tokens: string[], run: string[]): boolean => {
  if (!run.length) return true;
  for (let i = 0; i + run.length <= tokens.length; i++)
    if (run.every((w, k) => tokens[i + k] === w)) return true;
  return false;
};

const notInQuote = (field: string, value: string) =>
  `${field} "${value}" isn't in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)`;

function dateIn(value: string, quote: string, tokens: string[]): boolean {
  if (quote.includes(value)) return true;
  const d = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!d) return valueTokens(value).every((t) => tokens.includes(t));
  const month = MONTHS[Number(d[2]) - 1];
  if (!month) return false;
  const named = tokens.includes(month) || tokens.includes(month.slice(0, 3));
  const day = d[3] === undefined || tokens.includes(String(Number(d[3])));
  return named && day && tokens.includes(d[1]!);
}

/** The problems with an item's values, one line each; none when every value is in a quote. */
export function groundValues(item: Valued, g: Grounding): string[] {
  const problems: string[] = [];
  const quoted = g.quotes.map((q) => ({ text: q, tokens: valueTokens(q) }));
  const anyQuote = (ok: (q: { text: string; tokens: string[] }) => boolean) => quoted.some(ok);
  if (item.lead_time?.trim()) {
    const want = valueTokens(item.lead_time).filter((t) => !FILLER.has(t));
    if (!anyQuote((q) => want.every((t) => q.tokens.includes(t))))
      problems.push(notInQuote("lead_time", item.lead_time));
  }
  for (const f of ["handled_by", "owned_by"] as const) {
    const v = item[f]?.trim();
    if (!v) continue;
    const want = valueTokens(v);
    if (want[0] === "the") want.shift();
    const own = g.owner && valueTokens(g.owner).join(" ") === want.join(" ");
    if (!own && !anyQuote((q) => hasRun(q.tokens, want))) problems.push(notInQuote(f, v));
  }
  for (const [k, v] of Object.entries(item.dates ?? {}))
    if (!anyQuote((q) => dateIn(v, q.text, q.tokens))) problems.push(notInQuote(`dates.${k}`, v));
  if (item.status && STANCE_WORDS[item.status]) {
    const words = STANCE_WORDS[item.status]!.map(valueTokens);
    if (!anyQuote((q) => words.some((w) => hasRun(q.tokens, w))))
      problems.push(
        `status "${item.status}" isn't in the quote: it needs words such as ${STANCE_HINT[item.status]}`,
      );
  }
  const onPages = new Set(g.pages.match(/\d+/g) ?? []);
  const said: [string, string[]][] = [
    ["rules", item.rules ?? []],
    ["applies_when", item.applies_when ? [item.applies_when] : []],
    ["inputs", item.inputs ?? []],
    ["steps", item.steps ?? []],
  ];
  for (const [f, lines] of said) {
    const missing = [
      ...new Set(lines.flatMap((l) => l.match(/\d+/g) ?? []).filter((n) => !onPages.has(n))),
    ];
    if (missing.length)
      problems.push(
        `${f}: ${missing.join(", ")} isn't on the page it quotes: write only the numbers the page states`,
      );
  }
  return problems;
}
