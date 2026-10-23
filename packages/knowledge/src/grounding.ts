/**
 * Values tied to the words they cite (ADR 0111, 0117). A knowledge item's quote is checked word
 * for word on its page (ADR 0083); this checks that what the item states as a value is said by
 * the words it cites. What a check can settle, it settles; the rest is a claim for a judge.
 *
 * - A value's span is the words that state it: `lead_time_quote`, `status_quote`,
 *   `date_quotes.<name>` (each on one of the item's pages, word for word), or else one of the
 *   item's quotes.
 * - Text is folded to tokens for the check: lower case, runs of letters or digits; an ordinal
 *   ("1st") is its number; the number words zero to twenty, the tens, and a tens-unit pair
 *   ("twenty-one") are digits; the time units minute, hour, day, week, month and year lose a
 *   plural "s". Format folding, not meaning: "working days" is not "business days".
 * - lead_time and handled_by / owned_by: settled when the value's tokens are a run of the span's
 *   tokens ("five working days" in "within five working days"; "3 days" is not in "3 approvers
 *   and take 15 days"). Else a claim, when every number of the value is in the span; else refused.
 *   An owner may also be the page's own owner.
 * - lead_time_days, the model's normalised lead time { min, max, unit }: settled when min and max
 *   are numbers of the span; else a claim ("a fortnight" is 10 working days).
 * - dates: settled when the span holds the date as written (2027-03-31), or as one run of its
 *   day, month name and year ("31 March 2027", "March 31, 2027"); else a claim.
 * - status: always a claim (a ban, a mandate or a retirement is meaning), its span on the page.
 * - rules, applies_when, inputs and steps are the model's summary, so their words aren't checked;
 *   each number they state (a run of digits) is on one of the item's pages.
 */

export interface Grounding {
  /** The item's quotes: its source quote and its also_on quotes, each already on its page. */
  quotes: string[];
  /** The visible text of every page the item quotes. */
  pages: string;
  /** The front matter's owner of the page the source quote is on. */
  owner?: string;
  /** Whether words are on one of the item's pages, word for word. Default: in `pages`. */
  onPage?: (span: string) => boolean;
}

export type LeadTimeUnit = "working-days" | "calendar-days" | "hours";
export interface LeadTimeDays {
  min: number;
  max: number;
  unit: LeadTimeUnit;
}

/** The fields of an item this checks; any other field is left alone. */
export interface Valued {
  lead_time?: string | undefined;
  lead_time_quote?: string | undefined;
  lead_time_days?: LeadTimeDays | undefined;
  handled_by?: string | undefined;
  owned_by?: string | undefined;
  status?: string | undefined;
  status_quote?: string | undefined;
  dates?: Record<string, string> | undefined;
  date_quotes?: Record<string, string> | undefined;
  rules?: string[];
  applies_when?: string | undefined;
  inputs?: string[];
  steps?: string[];
}

/** A value its span may state but no check can settle: a judge decides, or it is the model's. */
export interface ValueClaim {
  field: string;
  value: string;
  span: string;
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

const numbersOf = (tokens: string[]) => tokens.filter((t) => /^\d+$/.test(t));

const fold = (s: string) =>
  s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const notInQuote = (field: string, value: string) =>
  `${field} "${value}" isn't in the quote: quote the line that states it (under also_on when it is another sentence, on this page or another)`;

/** The date as one run of the span's tokens: ISO as written, or day, month name and year. */
function dateWritten(value: string, span: string): boolean {
  if (span.includes(value)) return true;
  const d = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!d) return hasRun(valueTokens(span), valueTokens(value));
  const month = MONTHS[Number(d[2]) - 1];
  if (!month) return false;
  const t = valueTokens(span);
  const year = d[1]!;
  const names = [month, month.slice(0, 3)];
  if (d[3] === undefined) return names.some((m) => hasRun(t, [m, year]));
  const day = String(Number(d[3]));
  return names.some((m) => hasRun(t, [day, m, year]) || hasRun(t, [m, day, year]));
}

/**
 * The problems with an item's values, one line each, and the claims a check can't settle; no
 * problems when every value is said by the words it cites.
 */
export function groundValues(
  item: Valued,
  g: Grounding,
): { problems: string[]; claims: ValueClaim[] } {
  const problems: string[] = [];
  const claims: ValueClaim[] = [];
  const pageText = fold(g.pages);
  const onPage = g.onPage ?? ((s: string) => pageText.includes(fold(s)));
  /** The spans a field's value is looked for in: its own, checked on the page, else the quotes. */
  const spansFor = (field: string, own: string | undefined): string[] | undefined => {
    if (own === undefined || !own.trim()) return g.quotes;
    if (!onPage(own)) {
      problems.push(`${field}: "${own}" isn't on the page it quotes: copy the words exactly`);
      return undefined;
    }
    return [own];
  };

  const lead = item.lead_time?.trim();
  if (lead) {
    const spans = spansFor("lead_time_quote", item.lead_time_quote);
    if (spans) {
      const want = valueTokens(lead);
      const written = spans.some((s) => hasRun(valueTokens(s), want));
      const span = spans.find((s) => {
        const have = new Set(numbersOf(valueTokens(s)));
        return numbersOf(want).every((n) => have.has(n));
      });
      if (!written) {
        if (span !== undefined && item.lead_time_quote?.trim())
          claims.push({ field: "lead_time", value: lead, span });
        else problems.push(notInQuote("lead_time", lead));
      }
      const days = item.lead_time_days;
      if (days) {
        const at = item.lead_time_quote?.trim() || spans.find((s) => hasRun(valueTokens(s), want));
        if (at === undefined)
          problems.push(`lead_time_days: give lead_time_quote, the words it is read from`);
        else {
          const have = new Set(numbersOf(valueTokens(at)));
          if (!have.has(String(days.min)) || !have.has(String(days.max)))
            claims.push({
              field: "lead_time_days",
              value: `${days.min === days.max ? days.min : `${days.min} to ${days.max}`} ${days.unit}`,
              span: at,
            });
        }
      }
    }
  }
  for (const f of ["handled_by", "owned_by"] as const) {
    const v = item[f]?.trim();
    if (!v) continue;
    const want = valueTokens(v);
    if (want[0] === "the") want.shift();
    const own = g.owner && valueTokens(g.owner).join(" ") === want.join(" ");
    if (!own && !g.quotes.some((q) => hasRun(valueTokens(q), want)))
      problems.push(notInQuote(f, v));
  }
  for (const [k, v] of Object.entries(item.dates ?? {})) {
    const spans = spansFor(`date_quotes.${k}`, item.date_quotes?.[k]);
    if (!spans) continue;
    if (spans.some((s) => dateWritten(v, s))) continue;
    const own = item.date_quotes?.[k]?.trim();
    if (own) claims.push({ field: `dates.${k}`, value: v, span: own });
    else problems.push(notInQuote(`dates.${k}`, v));
  }
  if (item.status) {
    const own = item.status_quote?.trim();
    if (!own)
      problems.push(
        `status "${item.status}": give status_quote, the words on the page that state it, copied exactly`,
      );
    else if (spansFor("status_quote", own))
      claims.push({ field: "status", value: item.status, span: own });
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
  return { problems, claims };
}

/**
 * Working days in a normalised lead time (ADR 0117): its upper bound, calendar days as five in
 * seven and hours as eight to a day, rounded up. Arithmetic on the model's normalised value; no
 * words are read.
 */
export function workingDays(d: LeadTimeDays): number {
  const n = Math.max(d.min, d.max);
  return Math.ceil(
    d.unit === "working-days" ? n : d.unit === "calendar-days" ? (n * 5) / 7 : n / 8,
  );
}
