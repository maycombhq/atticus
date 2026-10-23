import type { Estimates } from "@maycombhq/core";

/**
 * A change's estimate (ADR 0109), worked out without AI and without guesses:
 *
 * - its size: each step a target flow adds, changes or removes is a unit of work, classed by
 *   what it is and what it reaches (`add/call-out/vendor/new-entry`); a new flow is one more unit
 *   and a removed flow one unit;
 * - its effort: the org pack's range for each class (`estimates.yaml`), summed by a simulation
 *   seeded by the change's id, so the same change always gets the same answer; a unit no class
 *   matches gets no number and is said to need one;
 * - its drivers: what makes it bigger or riskier, each with a count and the file it comes from;
 *   the org pack's factor for a risk widens the upper end only;
 * - its calendar: the later of the work and the waiting the release forecast found.
 *
 * Until past changes record their effort it says it isn't calibrated, and whose figures it uses.
 */

type Mark = "same" | "changed" | "added" | "removed";

/** A target flow as the merge gives it, the parts an estimate reads. */
export interface EstimateFlow {
  flow: string;
  repo: string;
  change: "modify" | "new" | "remove";
  /** A new flow: what starts it (endpoint, job, listener...). */
  trigger?: string;
  /** The target-flow file, relative to the metarepo: every unit cites it. */
  file: string;
  steps: {
    mark: Mark;
    kind: string;
    today?: number;
    target?: number;
    what?: string;
    to?: { component: string; entry?: string; new?: boolean };
    store?: { table: string; new?: boolean; migration?: string };
    /** Today's step: who confirmed it (check, ai, person); none when no one did. */
    confirmedBy?: string;
  }[];
}

export interface DayRange {
  p20: number;
  p50: number;
  p80: number;
}

export interface EstimateUnit {
  flow: string;
  repo: string;
  /** The step's number (in the target flow; today's for a removed step); none for a whole flow. */
  step?: number;
  what: string;
  class: string;
  /** The org pack's range for its class; none when no class matches. */
  days?: DayRange;
  source: string;
}

export interface EstimateDriver {
  id:
    | "new-vendor-call"
    | "new-table"
    | "migration"
    | "unconfirmed-step"
    | "open-blocking"
    | "open-questions"
    | "conflicts"
    | "repos";
  what: string;
  count: number;
  /** The org pack's factor on the upper end, when it sets one for this risk. */
  widens?: number;
  source?: string;
}

export interface ChangeEstimate {
  change: string;
  units: EstimateUnit[];
  /** Units no class matches: they get no number. */
  needsClass: number;
  /** The summed range, when the org pack has ranges and at least one unit is classed. */
  effort?: DayRange;
  perRepo: { repo: string; units: number; effort?: DayRange }[];
  drivers: EstimateDriver[];
  calendar: { effortDays?: number; waitDays?: number; longer?: "work" | "waiting" };
  calibration: { calibrated: false; source?: string };
}

export interface EstimateInput {
  change: string;
  flows: EstimateFlow[];
  /** The org pack's estimates.yaml; none, and the estimate sizes the work only. */
  table?: Estimates;
  /** The boundary of a component's system (product, internal, vendor). */
  boundaryOf: (component: string) => string | undefined;
  openBlocking?: number;
  openQuestions?: number;
  /** Other open changes on the same systems or flows. */
  conflicts?: number;
  /** Working days the release forecast waits (lead times along the deployment plan). */
  waitDays?: number;
}

const CALLS = new Set(["call-out", "publish"]);
const OP: Record<Exclude<Mark, "same">, string> = {
  added: "add",
  changed: "change",
  removed: "remove",
};

/** A step's class of work: its op and kind, then what it reaches. */
export function classOf(
  s: EstimateFlow["steps"][number],
  boundaryOf: (component: string) => string | undefined,
): string {
  const parts = [OP[s.mark as Exclude<Mark, "same">] ?? "keep", s.kind];
  if (s.to && CALLS.has(s.kind)) {
    if (boundaryOf(s.to.component) === "vendor") parts.push("vendor");
    if (s.to.new) parts.push("new-entry");
  }
  if (s.store?.new) parts.push("new-table");
  else if (s.store?.migration) parts.push("migration");
  return parts.join("/");
}

/** The first class in the table that matches: itself, or its first segments then `*`. */
function rangeOf(cls: string, table: Estimates | undefined): DayRange | undefined {
  for (const c of table?.classes ?? []) {
    if (c.match === "*" || c.match === cls) return c.days;
    if (c.match.endsWith("/*") && `${cls}/`.startsWith(c.match.slice(0, -1))) return c.days;
  }
  return undefined;
}

/** A small seeded generator (mulberry32), so a simulation is the same every run. */
function seeded(text: string): () => number {
  let a = 2166136261;
  for (const ch of text) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** z of the 80th percentile: a range's p20 and p80 sit this many deviations from its middle. */
const Z80 = 0.8416;
const SAMPLES = 4000;

/** A log-normal through the range's middle (p50), as wide as its p20 to p80. */
function sampler(next: () => number) {
  return (d: DayRange) => {
    const sigma = (Math.log(d.p80) - Math.log(d.p20)) / (2 * Z80);
    const u = Math.max(next(), 1e-12);
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    return Math.exp(Math.log(d.p50) + sigma * n);
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

function quantiles(xs: number[]): DayRange {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p20: round(at(0.2)), p50: round(at(0.5)), p80: round(at(0.8)) };
}

export function estimateChange(input: EstimateInput): ChangeEstimate {
  const units: EstimateUnit[] = [];
  const drivers = new Map<EstimateDriver["id"], EstimateDriver>();
  const factor = (id: string) => input.table?.risks[id];
  const drive = (id: EstimateDriver["id"], what: string, count: number, source?: string) => {
    if (!count) return;
    const d = drivers.get(id);
    if (d) d.count += count;
    else {
      const w = factor(id);
      drivers.set(id, {
        id,
        what,
        count,
        ...(w && w > 1 ? { widens: w } : {}),
        ...(source ? { source } : {}),
      });
    }
  };
  for (const f of input.flows) {
    const unit = (u: Omit<EstimateUnit, "flow" | "repo" | "source" | "days">) => {
      const days = rangeOf(u.class, input.table);
      units.push({ flow: f.flow, repo: f.repo, ...u, ...(days ? { days } : {}), source: f.file });
    };
    if (f.change === "remove") {
      unit({ what: `${f.flow} goes`, class: "remove-flow" });
      continue;
    }
    if (f.change === "new")
      unit({ what: `${f.flow} is new`, class: `new-flow/${f.trigger ?? "endpoint"}` });
    for (const s of f.steps) {
      if (s.mark === "same") continue;
      const step = s.target ?? s.today;
      unit({
        ...(step !== undefined ? { step } : {}),
        what: s.what ?? s.kind,
        class: classOf(s, input.boundaryOf),
      });
      if (s.mark === "removed") continue;
      if (s.to && CALLS.has(s.kind) && s.to.new && input.boundaryOf(s.to.component) === "vendor")
        drive("new-vendor-call", "New calls to a vendor", 1, f.file);
      if (s.store?.new) drive("new-table", "New tables", 1, f.file);
      else if (s.store?.migration) drive("migration", "Migrations", 1, f.file);
    }
    const unconfirmed = f.steps.filter(
      (s) =>
        (s.mark === "changed" || s.mark === "removed") &&
        (!s.confirmedBy || s.confirmedBy === "ai"),
    ).length;
    drive("unconfirmed-step", "Changed steps no check or person confirmed", unconfirmed, f.file);
  }
  drive("open-blocking", "Open blocking findings", input.openBlocking ?? 0);
  drive("open-questions", "Open questions", input.openQuestions ?? 0);
  drive("conflicts", "Other open changes on the same parts", input.conflicts ?? 0);
  const repos = [...new Set(input.flows.map((f) => f.repo))].sort();
  if (repos.length > 1) drive("repos", "Repos to change", repos.length);
  const ORDER: EstimateDriver["id"][] = [
    "new-vendor-call",
    "new-table",
    "migration",
    "unconfirmed-step",
    "open-blocking",
    "open-questions",
    "conflicts",
    "repos",
  ];
  const listed = ORDER.flatMap((id) => (drivers.has(id) ? [drivers.get(id)!] : []));

  const classed = units.filter((u) => u.days);
  let effort: DayRange | undefined;
  const perRepo: ChangeEstimate["perRepo"] = repos.map((repo) => ({
    repo,
    units: units.filter((u) => u.repo === repo).length,
  }));
  if (classed.length) {
    const draw = sampler(seeded(input.change));
    const totals: number[] = [];
    const byRepo = new Map(repos.map((r) => [r, [] as number[]]));
    const extra = input.table?.perExtraRepo;
    for (let i = 0; i < SAMPLES; i++) {
      let total = 0;
      for (const r of repos) {
        let sum = 0;
        for (const u of classed) if (u.repo === r) sum += draw(u.days!);
        byRepo.get(r)!.push(sum);
        total += sum;
      }
      if (extra) for (let k = 1; k < repos.length; k++) total += draw(extra);
      totals.push(total);
    }
    // A risk's factor widens the upper end; the middle moves only when calibration shows it does.
    const widen = listed.reduce((w, d) => w * (d.widens ?? 1), 1);
    const q = quantiles(totals);
    effort = { ...q, p80: round(q.p80 * widen) };
    for (const p of perRepo)
      if (classed.some((u) => u.repo === p.repo)) p.effort = quantiles(byRepo.get(p.repo)!);
  }
  const calendar: ChangeEstimate["calendar"] = {
    ...(effort ? { effortDays: effort.p80 } : {}),
    ...(input.waitDays !== undefined ? { waitDays: input.waitDays } : {}),
  };
  if (effort && input.waitDays !== undefined)
    calendar.longer = effort.p80 > input.waitDays ? "work" : "waiting";
  else if (input.waitDays !== undefined) calendar.longer = "waiting";
  return {
    change: input.change,
    units,
    needsClass: units.length - classed.length,
    ...(effort ? { effort } : {}),
    perRepo,
    drivers: listed,
    calendar,
    calibration: {
      calibrated: false,
      ...(input.table ? { source: input.table.source } : {}),
    },
  };
}
