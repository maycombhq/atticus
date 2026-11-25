import { appendFile, mkdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { currentPlanListener, currentRunIo, runsDirOf, type BudgetLimit } from "@maycombhq/core";
import { RuntimeError, type AiRuntime } from "./runtime.js";

/**
 * A budget, said before it is spent (ADR 0210 part 5). Every run that calls a model says first how
 * many sessions (prompts) and tokens it plans, checks that its result can be written, and, past
 * runtime.yaml's `budgets.limits`, asks at a terminal or stops unattended, before its first
 * request. What a person spends is counted on their machine, beside the runs, never in the catalog.
 */
export interface RunPlan {
  /** What runs, as the line names it: "The read of forge-orders". */
  what: string;
  sessions: number;
  tokens: number;
  /** Its result is written (a read's facts): the preflight runs first. */
  writes?: boolean;
}
export interface Spent {
  sessions: number;
  tokens: number;
}
let preflight: ((root: string) => Promise<string | undefined>) | undefined;
/** What a run that writes checks first (no lock held, no upgrade owed); the command line registers it. */
export function registerRunPreflight(p: typeof preflight): void {
  preflight = p;
}

const n = (x: number) => x.toLocaleString("en-US");
const of = (x: number, w: string) => `${n(x)} ${w}${x === 1 ? "" : "s"}`;
const limitWords = (l: BudgetLimit) =>
  [l.sessions && of(l.sessions, "session"), l.tokens && of(l.tokens, "token")]
    .filter(Boolean)
    .join(" and ") + ` a ${l.per}`;

/** Every word of the budget, in one constant. */
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

/** This person's count: `.runs/.usage/<user>.jsonl`, one line a request. */
export function usageFileOf(root: string, user = userInfo().username): string {
  return join(runsDirOf(root), ".usage", `${user.replace(/[^\w.-]/g, "_") || "user"}.jsonl`);
}

/** Where a period began, by UTC (as providers bill); a run's own count starts at nothing. */
const since = (per: BudgetLimit["per"], now: Date) =>
  per === "day"
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    : per === "month"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      : Infinity;

export async function usedIn(root: string, per: BudgetLimit["per"], now: Date): Promise<Spent> {
  const from = since(per, now);
  const out = { sessions: 0, tokens: 0 };
  const text = await readFile(usageFileOf(root), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    try {
      const u = JSON.parse(line) as Spent & { at: string };
      if (Date.parse(u.at) < from) continue;
      out.sessions += u.sessions || 0;
      out.tokens += u.tokens || 0;
    } catch {
      // a line cut short is passed over
    }
  }
  return out;
}

async function recordUsage(root: string, s: Spent, now: Date): Promise<void> {
  const file = usageFileOf(root);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ at: now.toISOString(), ...s })}\n`, "utf8");
}

type Used = Partial<Record<BudgetLimit["per"], Spent>>;
/** Each limit, with what its day or month used. */
const limitsWords = (limits: readonly BudgetLimit[], used: Used) =>
  limits
    .map((l) => {
      const u = used[l.per];
      const spent = u && [l.sessions && n(u.sessions), l.tokens && n(u.tokens)].filter(Boolean);
      return `${limitWords(l)}${l.per !== "run" && spent ? ` (${spent.join(" and ")} used)` : ""}`;
    })
    .join(", ");

export function planLine(p: RunPlan, limits: readonly BudgetLimit[], used: Used): string {
  return `${BUDGET_WORDS.plan(p)}; ${limits.length ? `limits: ${limitsWords(limits, used)}` : BUDGET_WORDS.none}.`;
}

/** atticus doctor's line: the limits and what this person used, and whether one is used up. */
export async function budgetStatus(
  root: string,
  limits: readonly BudgetLimit[],
  now = new Date(),
): Promise<{ line: string; spent: boolean }> {
  const used = { day: await usedIn(root, "day", now), month: await usedIn(root, "month", now) };
  const both = (u: Spent) => `${of(u.sessions, "session")} and ${of(u.tokens, "token")}`;
  if (!limits.length)
    return {
      line: `${BUDGET_WORDS.none}; used here today ${both(used.day)}, this month ${both(used.month)}`,
      spent: false,
    };
  const spent = limits.some((l) => {
    const u = l.per === "run" ? undefined : used[l.per];
    return (
      !!u && ((!!l.sessions && u.sessions >= l.sessions) || (!!l.tokens && u.tokens >= l.tokens))
    );
  });
  return { line: `${limitsWords(limits, used)}${spent ? "; a limit is used up" : ""}`, spent };
}

/** The first limit a plan would pass, in words; undefined within every limit. */
function overOf(p: RunPlan, limits: readonly BudgetLimit[], used: Partial<Record<string, Spent>>) {
  for (const l of limits) {
    const u = used[l.per] ?? { sessions: 0, tokens: 0 };
    if (l.sessions && u.sessions + p.sessions > l.sessions)
      return BUDGET_WORDS.over(l, u.sessions, p.sessions);
    if (l.tokens && u.tokens + p.tokens > l.tokens) return BUDGET_WORDS.over(l, u.tokens, p.tokens);
  }
  return undefined;
}

interface Budget {
  root: string;
  limits: readonly BudgetLimit[];
  now: () => Date;
  /** undefined until the plan is said; then the stop's words, or "" to go on. */
  said?: string;
}
const budgets = new WeakMap<AiRuntime, Budget>();

/** Say the plan and check it; the words of the stop, or undefined to go on. Once a runtime. */
export async function planRun(rt: AiRuntime, p: RunPlan): Promise<string | undefined> {
  const b = budgets.get(rt);
  if (!b) return undefined;
  if (b.said === undefined) b.said = await begin(b, p);
  return b.said || undefined;
}

async function begin(b: Budget, p: RunPlan): Promise<string> {
  const io = currentRunIo();
  const now = b.now();
  const used: Partial<Record<BudgetLimit["per"], Spent>> = {};
  for (const l of b.limits) used[l.per] = await usedIn(b.root, l.per, now);
  const line = planLine(p, b.limits, used);
  io?.say(line);
  currentPlanListener()?.(line);
  const refused = p.writes ? await preflight?.(b.root) : undefined;
  if (refused) return `${refused} ${BUDGET_WORDS.nothing}`;
  const over = overOf(p, b.limits, used);
  if (!over || io?.yes) return "";
  if (io?.ask)
    return /^(y|yes)$/i.test((await io.ask(`${over} ${BUDGET_WORDS.ask}`))?.trim() ?? "")
      ? ""
      : BUDGET_WORDS.nothing;
  return `${over} ${BUDGET_WORDS.nothing} ${BUDGET_WORDS.stop}`;
}

/**
 * Put a runtime under runtime.yaml's budget (the command line's runtime, `runtimeForCli`): its
 * first request says a plan of one session if its run said none (`planRun`), a stopped plan
 * refuses every request, and each request's tokens are counted (a hand-off's: its prompt's).
 */
export function budgetRuntime<R extends AiRuntime>(
  rt: R,
  o: { root: string; limits?: readonly BudgetLimit[]; now?: () => Date },
): R {
  const b: Budget = { root: o.root, limits: o.limits ?? [], now: o.now ?? (() => new Date()) };
  budgets.set(rt, b);
  const run = rt.run.bind(rt);
  rt.run = async (runId, signal) => {
    if (b.said === undefined) {
      const r = (await rt.result(runId)).request;
      await planRun(rt, { what: r.agent.id, sessions: 1, tokens: r.pack.manifest.totalTokens });
    }
    if (b.said) throw new RuntimeError(b.said);
    const done = await run(runId, signal);
    const u = done.usage;
    const tokens = u ? u.inputTokens + u.outputTokens : done.request.pack.manifest.totalTokens;
    if (done.state !== "cancelled") await recordUsage(b.root, { sessions: 1, tokens }, b.now());
    return done;
  };
  return rt;
}
