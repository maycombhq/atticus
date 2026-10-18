/**
 * Working-day arithmetic for plans. Dates are ISO days (YYYY-MM-DD) in UTC; working days are
 * Monday to Friday. Public holidays are not known to Atticus, so they are not skipped: lead
 * times are kept honest by the parties' own figures instead. Pure and deterministic.
 */

const DAY = 86_400_000;

export const isIsoDay = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);
const isWeekday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

/** The day part of a timestamp or day. */
export const dayOf = (at: string | Date) => (typeof at === "string" ? at.slice(0, 10) : toDay(at));

/** The same day when it is a weekday, else the Friday before. */
export function weekdayOnOrBefore(day: string): string {
  let d = toDate(day);
  while (!isWeekday(d)) d = new Date(d.getTime() - DAY);
  return toDay(d);
}

/** `n` working days after `day` (n = 0 returns the day itself). */
export function addWorkingDays(day: string, n: number): string {
  let d = toDate(day);
  for (let i = 0; i < n;) {
    d = new Date(d.getTime() + DAY);
    if (isWeekday(d)) i++;
  }
  return toDay(d);
}

/** `n` working days before `day`: the start a task of n days needs to finish by `day`. */
export function subtractWorkingDays(day: string, n: number): string {
  let d = toDate(day);
  for (let i = 0; i < n;) {
    d = new Date(d.getTime() - DAY);
    if (isWeekday(d)) i++;
  }
  return toDay(d);
}

/**
 * Working days from `from` to `to`, not counting `from` (the same rule as the planner's lead
 * times from past requests). Negative when `to` is before `from`.
 */
export function workingDays(from: string, to: string): number {
  if (to < from) return -workingDays(to, from);
  let n = 0;
  for (
    let d = new Date(toDate(from).getTime() + DAY);
    d <= toDate(to);
    d = new Date(d.getTime() + DAY)
  )
    if (isWeekday(d)) n++;
  return n;
}

export const laterOf = (a: string, b: string) => (a > b ? a : b);
export const earlierOf = (a: string, b: string) => (a < b ? a : b);

/**
 * A lead time as written in `Party.typicalLeadTimes`: "10d" or "10 days" (working days),
 * "2w" or "2 weeks" (five working days a week), or a bare number of days. Undefined when the
 * text says something else.
 */
export function parseLeadTime(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(d|days?|wd|working days?|w|weeks?)?\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "d").toLowerCase();
  return Math.ceil(
    unit.startsWith("w") && unit !== "wd" && !unit.startsWith("working") ? n * 5 : n,
  );
}
