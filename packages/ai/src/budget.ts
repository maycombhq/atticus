import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { currentRunIo, limitWords, runsDirOf, type BudgetLimit } from "@maycombhq/core";
import { RuntimeError, type AiRuntime } from "./runtime.js";

/**
 * A budget, said before it is spent (ADR 0210 part 5). Every run that calls a model says first how
 * many sessions (prompts) and tokens it plans, checks that its result can be written, and, past
 * runtime.yaml's `budgets.limits`, asks at a terminal or stops unattended, before its first
 * request; once it spends past its plan, each request checks again. One command's runs share one
 * plan (its RunIo). What a person spends is counted on their machine, never in the catalog.
 */
export interface Spent {
  sessions: number;
  tokens: number;
}
/** `what` as the line names it ("The read of forge-orders"); `writes`: the preflight runs first. */
export interface RunPlan extends Spent {
  what: string;
  writes?: boolean;
}
/** Where a budget counts and what it may spend. */
export type BudgetOf = {
  root: string;
  limits?: readonly BudgetLimit[] | undefined;
  now?: () => Date;
};
const zero = (): Spent => ({ sessions: 0, tokens: 0 });
const add = (a: Spent, b: Spent): Spent => ({
  sessions: a.sessions + (b.sessions || 0),
  tokens: a.tokens + (b.tokens || 0),
});
const nowOf = (b: BudgetOf) => (b.now ?? (() => new Date()))();

const n = (x: number) => x.toLocaleString("en-US");
const of = (x: number, w: string) => `${n(x)} ${w}${x === 1 ? "" : "s"}`;
export const BUDGET_WORDS = {
  plan: (p: RunPlan) =>
    `Budget: ${p.what} plans ${of(p.sessions, "session")} and about ${of(p.tokens, "token")}`,
  none: "no limit is set (budgets.limits in runtime.yaml)",
  over: (l: BudgetLimit, used: number, planned: number) =>
    `This run would pass ${limitWords(l)}: ${n(used)} used and ${n(planned)} planned.`,
  ask: "Run it anyway? [y/N]",
  nothing: "Nothing was sent.",
  stop: "Confirm it at a terminal, run it with --yes, or raise budgets.limits in org-pack/runtime.yaml.",
} as const;

/** A user name as a file name on any system: Windows' reserved names kept apart, others encoded. */
export function safeUserName(user: string): string {
  const s = encodeURIComponent(user).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  );
  if (/^\.*$/.test(s)) return "user";
  return /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(\..*)?$/i.test(s) ? `_${s}` : s;
}
function localUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "user";
  }
}
/** This person's count: `.runs/.usage/<user>.jsonl`, one line a request. */
export const usageFileOf = (root: string, user = localUser()) =>
  join(runsDirOf(root), ".usage", `${safeUserName(user)}.jsonl`);

/** Where a period began, by UTC (as providers bill); a run's own count is the command's. */
const since = (per: BudgetLimit["per"], now: Date, back = 0) =>
  per === "day"
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    : per === "month"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)
      : Infinity;

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l) as Spent & { at: string }];
    } catch {
      return []; // a line cut short is passed over
    }
  });

export const usedIn = async (root: string, per: BudgetLimit["per"], now: Date): Promise<Spent> =>
  (await lines(usageFileOf(root)))
    .filter((u) => Date.parse(u.at) >= since(per, now))
    .reduce(add, zero());

/** With the runs' pruning: every person's count keeps this month and the last. */
export async function pruneUsage(root: string, now = new Date()): Promise<void> {
  const dir = join(runsDirOf(root), ".usage");
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const kept = (await lines(join(dir, f))).filter(
      (u) => Date.parse(u.at) >= since("month", now, 1),
    );
    await writeFile(join(dir, f), kept.map((u) => `${JSON.stringify(u)}\n`).join(""));
  }
}

type Used = Partial<Record<BudgetLimit["per"], Spent>>;
/** Each limit, with what its day or month used (`atticus doctor`'s line too). */
export const limitsWords = (limits: readonly BudgetLimit[], used: Used) =>
  limits
    .map((l) => {
      const u = used[l.per];
      const spent = u && [l.sessions && n(u.sessions), l.tokens && n(u.tokens)].filter(Boolean);
      return `${limitWords(l)}${l.per !== "run" && spent ? ` (${spent.join(" and ")} used)` : ""}`;
    })
    .join(", ");

export const planLine = (p: RunPlan, limits: readonly BudgetLimit[], used: Used) =>
  `${BUDGET_WORDS.plan(p)}; ${limits.length ? `limits: ${limitsWords(limits, used)}` : BUDGET_WORDS.none}.`;

/** The first limit `p` would pass beside what is used, in words; undefined within every limit. */
export function overOf(p: Spent, limits: readonly BudgetLimit[], used: Used): string | undefined {
  for (const l of limits) {
    const u = used[l.per] ?? zero();
    if (l.sessions && u.sessions + p.sessions > l.sessions)
      return BUDGET_WORDS.over(l, u.sessions, p.sessions);
    if (l.tokens && u.tokens + p.tokens > l.tokens) return BUDGET_WORDS.over(l, u.tokens, p.tokens);
  }
  return undefined;
}

/** One command's budget: `said`, the stop's words ("" to go on) once its plan is said; `yes`, a person's. */
type State = { said?: string; planned: Spent; spent: Spent; yes?: boolean };
const states = new WeakMap<object, State>();
const stateOf = (b: BudgetOf): State => {
  const key = currentRunIo() ?? b;
  if (!states.has(key)) states.set(key, { planned: zero(), spent: zero() });
  return states.get(key)!;
};
const runtimes = new WeakMap<AiRuntime, BudgetOf>();

async function usedNow(b: BudgetOf, s: State): Promise<Used> {
  const used: Used = { run: s.spent };
  for (const l of b.limits ?? [])
    if (l.per !== "run") used[l.per] = await usedIn(b.root, l.per, nowOf(b));
  return used;
}

/** Past a limit: "" to go on (--yes, or a person's yes), else the stop's words. */
async function decide(s: State, over: string | undefined): Promise<string> {
  const io = currentRunIo();
  if (!over || io?.yes || s.yes) return "";
  if (!io?.ask) return `${over} ${BUDGET_WORDS.nothing} ${BUDGET_WORDS.stop}`;
  s.yes = /^(y|yes)$/i.test((await io.ask(`${over} ${BUDGET_WORDS.ask}`))?.trim() ?? "");
  return s.yes ? "" : BUDGET_WORDS.nothing;
}

/** Say the plan and check it, once a command: the stop's words, or undefined to go on. */
export async function planRun(to: AiRuntime | BudgetOf, p: RunPlan): Promise<string | undefined> {
  const b = "root" in to ? to : runtimes.get(to);
  if (!b) return undefined;
  const s = stateOf(b);
  if (s.said === undefined) {
    s.planned = add(zero(), p);
    const used = await usedNow(b, s);
    currentRunIo()?.say(planLine(p, b.limits ?? [], used));
    const refused = p.writes ? await currentRunIo()?.preflight?.(b.root) : undefined;
    s.said = refused
      ? `${refused} ${BUDGET_WORDS.nothing}`
      : await decide(s, overOf(p, b.limits ?? [], used));
  }
  return s.said || undefined;
}

/**
 * Send one request under the budget: its plan said first if none was (one session of its
 * prompt), checked again once the command spends past its plan, and counted as sent whatever
 * becomes of it (cancelled too, with its prompt's tokens). A count that can't be written never
 * fails a run with no limit.
 */
export async function withBudget<T>(
  b: BudgetOf,
  req: { what: string; tokens: number },
  send: () => Promise<T>,
  spent: (r: T) => number | undefined = () => undefined,
): Promise<T> {
  const s = stateOf(b);
  if (s.said === undefined) await planRun(b, { what: req.what, sessions: 1, tokens: req.tokens });
  const one = { sessions: 1, tokens: req.tokens };
  const next = add(s.spent, one);
  if (!s.said && (next.sessions > s.planned.sessions || next.tokens > s.planned.tokens))
    s.said = await decide(s, overOf(one, b.limits ?? [], await usedNow(b, s)));
  if (s.said) throw new RuntimeError(s.said);
  let r: T | undefined;
  try {
    return (r = await send());
  } finally {
    const used = { sessions: 1, tokens: (r !== undefined && spent(r)) || req.tokens };
    s.spent = add(s.spent, used);
    const file = usageFileOf(b.root);
    await mkdir(dirname(file), { recursive: true })
      .then(() => appendFile(file, `${JSON.stringify({ at: nowOf(b).toISOString(), ...used })}\n`))
      .catch((e: unknown) => {
        if (b.limits?.length) throw e;
      });
  }
}

/** Put a runtime under runtime.yaml's budget, each request through `withBudget`; never a replay. */
export function budgetRuntime<R extends AiRuntime>(rt: R, b: BudgetOf): R {
  if (rt.kind === "replay") return rt;
  runtimes.set(rt, b);
  const run = rt.run.bind(rt);
  rt.run = async (runId, signal) => {
    const r = (await rt.result(runId)).request;
    return withBudget(
      b,
      { what: r.agent.id, tokens: r.pack.manifest.totalTokens },
      () => run(runId, signal),
      (d) => (d.usage ? d.usage.inputTokens + d.usage.outputTokens : undefined),
    );
  };
  return rt;
}
