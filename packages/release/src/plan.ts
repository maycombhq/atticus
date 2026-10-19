import { readStoryIndex, readTasks } from "@maycombhq/naysayer";
import { addWorkingDays, dayOf, laterOf, workingDays } from "@maycombhq/initiatives";
import { REQUESTS_FILE, type ReleaseContext, type ServiceRequestView } from "./context.js";
import {
  buildModel,
  hasWord,
  opOf,
  sectionOf,
  sectionsOf,
  sentences,
  sortStrings,
  type Model,
} from "./model.js";

/**
 * The deployment plan: a deploy order across the change's repos computed from dependencies,
 * never typed by hand. A gateway route goes before its caller, a topic before its publisher, a
 * migration (expand) before the code that reads the table, a callee before its caller for a
 * new or changed interface, and a story's repos after the repos of the stories it depends on.
 * Each step says why it sits where it does, how to roll it back (from design.md and data.md,
 * or a flagged gap), and which service requests it waits on with a forecast wait in working
 * days. The release sections (rollout, rollback, readiness, verification, hypercare) come from
 * design.md headings, and the release lens's open findings are shown, not re-checked.
 */

export type StepKind = "migration" | "topic" | "gateway-route" | "code";

export interface RequestWait {
  heading: string;
  template?: string;
  requestType: string;
  record?: string;
  state: ServiceRequestView["state"];
  number?: string;
  leadTimeDays?: number;
  leadTimeSource?: string;
  /** Working days from today until it is expected done (0 when it should be done already). */
  waitDays?: number;
  /** The day it is expected done. */
  readyBy?: string;
  missing: string[];
  /** "snow.md:3" */
  source: string;
  why: string;
}

export interface Rollback {
  text?: string;
  source?: string;
  /** Set when no rollback is written for the step. */
  gap?: string;
}

export interface PlanStep {
  n: number;
  repo: string;
  kind: StepKind;
  /** What deploys in this step. */
  what: string[];
  /** Why the step sits where it does. */
  why: string[];
  /** Steps that must be done first. */
  after: number[];
  rollback: Rollback;
  waitsOn: RequestWait[];
  /** The earliest day the step can deploy, as far as service requests and earlier steps allow. */
  earliest: string;
  /** Working days from today until then. */
  waitDays: number;
  sources: string[];
}

export interface PlanSection {
  name: "rollout" | "rollback" | "readiness" | "verification" | "hypercare";
  heading?: string;
  source?: string;
  text?: string;
  gap?: string;
}

export interface PlanFinding {
  gate: string;
  id: string;
  rule: string;
  severity: string;
  state: string;
  summary: string;
  path: string;
}

export interface DeploymentPlan {
  change: string;
  title: string;
  state: string;
  today: string;
  steps: PlanStep[];
  /** Requests no step is tied to: they wait before the first step. */
  before: RequestWait[];
  /** Systems outside the estate the plan relies on (vendors): nothing of theirs deploys here. */
  external: { system: string; name: string; what: string; beforeStep?: number }[];
  /** Components the change touches that the plan can't place, with why. */
  unplaced: { id: string; why: string }[];
  sections: PlanSection[];
  /** Open findings of the critic's release lens, newest round per gate. */
  findings: PlanFinding[];
  /** Earliest day every step can deploy. */
  earliest: string;
  gaps: string[];
  notes: string[];
}

const RANK: Record<StepKind, number> = { migration: 0, topic: 1, "gateway-route": 2, code: 3 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Unit {
  key: string;
  kind: StepKind;
  repo: string;
  what: string[];
  sources: Set<string>;
  /** Words that name this unit in prose: repo, components, migration files, tables, routes. */
  names: string[];
  /** Task numbers in this unit's repo. */
  tasks: string[];
}

interface Edge {
  from: string;
  to: string;
  why: string;
}

function requestWait(ctx: ReleaseContext, r: ServiceRequestView, why: string): RequestWait {
  const base = {
    heading: r.heading,
    ...(r.template ? { template: r.template } : {}),
    requestType: r.requestType,
    ...(r.record ? { record: r.record } : {}),
    state: r.state,
    ...(r.number ? { number: r.number } : {}),
    missing: r.missing,
    source: `${REQUESTS_FILE}:${r.line}`,
    why,
  };
  if (r.leadTimeDays === undefined) return base;
  const from = r.state === "filed" && r.filedAt ? dayOf(r.filedAt) : ctx.today;
  const due = addWorkingDays(from, Math.ceil(r.leadTimeDays));
  const readyBy = laterOf(due, ctx.today);
  return {
    ...base,
    leadTimeDays: r.leadTimeDays,
    ...(r.leadTimeSource ? { leadTimeSource: r.leadTimeSource } : {}),
    waitDays: workingDays(ctx.today, readyBy),
    readyBy,
  };
}

const ROLLBACK =
  /\b(roll(?:ed|ing)?[ -]?back|revert(?:ed|ing)?|back[ -]?out|undo|down[ -]?migration|restore)\b/i;

const SECTIONS: { name: PlanSection["name"]; re: RegExp; gap: string }[] = [
  {
    name: "rollout",
    re: /roll-?out|release plan|deploy|cut-?over/i,
    gap: 'design.md has no rollout section: add "Rollout and rollback" with the order and any feature flags.',
  },
  {
    name: "rollback",
    re: /roll-?back|back-?out/i,
    gap: "design.md says nothing about rolling back: say how each step is undone, and when to decide.",
  },
  {
    name: "readiness",
    re: /readiness|ready|pre-?release|go-?live|operational/i,
    gap: "design.md has no readiness section: say what must be true before go-live (runbooks, on-call, alerts, sign-offs).",
  },
  {
    name: "verification",
    re: /verif|smoke|post-?(deploy|release)|validation/i,
    gap: "design.md has no verification section: say how the team checks each step worked in production.",
  },
  {
    name: "hypercare",
    re: /hyper-?care|early life|warranty|aftercare|monitoring after/i,
    gap: "design.md has no hypercare section: say who watches what, and for how long, after release.",
  },
];

export async function deploymentPlan(ctx: ReleaseContext): Promise<DeploymentPlan> {
  const m: Model = buildModel(ctx);
  const gaps: string[] = [];
  const notes: string[] = [];
  const units = new Map<string, Unit>();
  const edges: Edge[] = [];
  const unplaced = new Map<string, string>();
  const external: DeploymentPlan["external"] = [];
  const externalCaller = new Map<string, string>();
  const tasks = readTasks(ctx.files);
  const stories = readStoryIndex(ctx.files);

  const unit = (key: string, kind: StepKind, repo: string): Unit => {
    let u = units.get(key);
    if (!u) {
      u = { key, kind, repo, what: [], sources: new Set(), names: [repo], tasks: [] };
      units.set(key, u);
    }
    return u;
  };
  const codeUnit = (repo: string) => {
    const u = unit(`code:${repo}`, "code", repo);
    for (const c of m.componentsOfRepo(repo)) if (!u.names.includes(c)) u.names.push(c);
    return u;
  };
  const addWhat = (u: Unit, w: string, source: string) => {
    if (!u.what.includes(w)) u.what.push(w);
    u.sources.add(source);
  };

  // ---- migrations: one step per data store, in the repo of the store's owner
  for (const d of m.data) {
    const owner = m.storeOwner(d.store);
    if (!owner.repo) {
      unplaced.set(
        d.store,
        `${d.store} has no owning component with a repo in the catalog, so its migration can't be placed.`,
      );
      continue;
    }
    const u = unit(`migration:${d.store}`, "migration", owner.repo);
    addWhat(
      u,
      `${d.store}.${d.table}: ${d.change.trim() || "change"} (${d.migration || "no migration file named"})`,
      `data.md:${d.line}`,
    );
    for (const n of [d.migration, d.table, d.tableId, d.store].filter(Boolean))
      if (!u.names.includes(n)) u.names.push(n);
    if (!d.migration)
      gaps.push(
        `data.md:${d.line}: the change to ${d.store}.${d.table} names no migration file, so the migration step can't say what runs.`,
      );
    // the code that reads or writes the table goes after the migration (expand first)
    const t = ctx.get("Table", d.tableId);
    const users = sortStrings([
      ...(t?.readers ?? []),
      ...(t?.writers ?? []),
      ...(owner.component ? [owner.component] : []),
    ]);
    for (const c of users) {
      const repo = m.repoOfComponent(c);
      if (!repo) continue;
      codeUnit(repo);
      edges.push({
        from: u.key,
        to: `code:${repo}`,
        why: `${c} reads or writes ${d.store}.${d.table}, so the migration (expand) runs first`,
      });
    }
  }

  // ---- hops: routes, topics and code
  for (const h of m.hops) {
    const live = /^planned-(new|modify)$/.test(h.change);
    const op = opOf(h);
    const src = `interfaces.md:${h.line}`;
    const callerInternal = h.callerBoundary !== "vendor";
    const calleeInternal = h.calleeBoundary !== "vendor";
    const verb =
      h.change === "planned-new" ? "new" : h.change === "planned-modify" ? "changed" : h.change;
    if (live && callerInternal) {
      if (h.callerRepo)
        addWhat(codeUnit(h.callerRepo), `${h.caller} calls ${op} on ${h.callee} (${verb})`, src);
      else unplaced.set(h.caller, placeWhy(ctx, h.caller, `caller of ${op}`));
    }
    if (live && calleeInternal) {
      if (h.calleeRepo) addWhat(codeUnit(h.calleeRepo), `${h.callee} serves ${op} (${verb})`, src);
      else unplaced.set(h.callee, placeWhy(ctx, h.callee, `callee of ${op}`));
    }
    if (live && !calleeInternal && h.calleeSystem) {
      const what = `${op} must be live on ${m.systemName(h.calleeSystem)}'s side (a vendor: nothing of theirs deploys here)`;
      external.push({ system: h.calleeSystem, name: m.systemName(h.calleeSystem), what });
      if (h.callerRepo) externalCaller.set(what, `code:${h.callerRepo}`);
    }
    // gateway routes the catalog doesn't know yet
    for (const r of h.newRoutes) {
      if (!m.gatewayRepo) {
        unplaced.set(
          r,
          `${r} is a new gateway route but no repo holds gateway proxies, so Atticus can't place it.`,
        );
        continue;
      }
      const u = unit(`route:${r}`, "gateway-route", m.gatewayRepo);
      addWhat(u, `New gateway route ${r} for ${op}`, src);
      if (!u.names.includes(r)) u.names.push(r);
      if (h.callerRepo && callerInternal)
        edges.push({
          from: u.key,
          to: `code:${h.callerRepo}`,
          why: `${h.caller} calls ${op} through ${r}, so the route goes first`,
        });
    }
    // topics the catalog doesn't know yet go before their publisher
    if (h.topic && h.newTopic && live) {
      if (!m.eventsRepo) {
        unplaced.set(
          h.topic,
          `${h.topic} is a new topic but no repo holds topic definitions, so Atticus can't place it.`,
        );
      } else {
        const u = unit(`topic:${h.topic}`, "topic", m.eventsRepo);
        addWhat(u, `New topic ${h.topic}`, src);
        if (!u.names.includes(h.topic)) u.names.push(h.topic);
        if (h.callerRepo)
          edges.push({
            from: u.key,
            to: `code:${h.callerRepo}`,
            why: `${h.caller} publishes to ${h.topic}, so the topic goes first`,
          });
      }
    }
    // callee before caller for a new or changed interface
    if (
      live &&
      h.callerRepo &&
      h.calleeRepo &&
      h.callerRepo !== h.calleeRepo &&
      callerInternal &&
      calleeInternal
    )
      edges.push({
        from: `code:${h.calleeRepo}`,
        to: `code:${h.callerRepo}`,
        why: `${h.caller} calls ${h.callee}'s ${verb} ${op}, so ${h.callee} deploys first`,
      });
  }

  // ---- repos named by tasks, stories, repos.yaml and change.yaml
  for (const t of tasks) {
    if (!ctx.repos.some((r) => r.id === t.repo) && !m.componentsOfRepo(t.repo).length) continue;
    const u = codeUnit(t.repo);
    const num = /\[[ xX]?\]\s*(\d+(?:\.\d+)*)/.exec(t.text)?.[1];
    if (num && !u.tasks.includes(num)) u.tasks.push(num);
    addWhat(u, `Task ${t.text.replace(/^\s*[-*]\s+\[[ xX]?\]\s*/, "")}`, `tasks.md:${t.line}`);
  }
  for (const s of stories)
    for (const repo of s.repos) {
      if (!ctx.repos.some((r) => r.id === repo)) continue;
      addWhat(codeUnit(repo), `Story ${s.id}`, `stories.md:${s.line}`);
    }
  for (const repo of [
    ...(ctx.changeRepos?.repos.map((r) => r.id) ?? []),
    ...ctx.change.touches.repos,
  ])
    if (!units.has(`code:${repo}`))
      addWhat(codeUnit(repo), "Named in the change's repos", "repos.yaml");
  // a story's repos deploy after the repos of the stories it depends on
  for (const s of stories)
    for (const dep of s.dependsOn) {
      const d = stories.find((x) => x.id === dep);
      if (!d) continue;
      for (const a of d.repos)
        for (const b of s.repos)
          if (a !== b && units.has(`code:${a}`) && units.has(`code:${b}`))
            edges.push({
              from: `code:${a}`,
              to: `code:${b}`,
              why: `story ${s.id} depends on ${d.id}`,
            });
    }

  // ---- order: Kahn's algorithm, ties by kind then repo
  const keys = [...units.keys()];
  const preds = new Map<string, Edge[]>(keys.map((k) => [k, []]));
  for (const e of edges)
    if (
      units.has(e.from) &&
      units.has(e.to) &&
      e.from !== e.to &&
      !preds.get(e.to)!.some((x) => x.from === e.from && x.why === e.why)
    )
      preds.get(e.to)!.push(e);
  const prio = (k: string) => {
    const u = units.get(k)!;
    return [RANK[u.kind], u.repo, k] as const;
  };
  const byPrio = (a: string, b: string) => {
    const [ra, pa, ka] = prio(a);
    const [rb, pb, kb] = prio(b);
    return ra !== rb ? ra - rb : pa !== pb ? cmp(pa, pb) : cmp(ka, kb);
  };
  const order: string[] = [];
  const left = new Set(keys);
  while (left.size) {
    const ready = [...left]
      .filter((k) => preds.get(k)!.every((e) => !left.has(e.from)))
      .sort(byPrio);
    if (ready.length) {
      order.push(ready[0]!);
      left.delete(ready[0]!);
      continue;
    }
    // a cycle: take the first by priority and say so
    const next = [...left].sort(byPrio)[0]!;
    const stuck = preds
      .get(next)!
      .filter((e) => left.has(e.from))
      .map((e) => units.get(e.from)!.repo);
    gaps.push(
      `${units.get(next)!.repo} and ${sortStrings(stuck).join(", ")} depend on each other, so no order satisfies both; agree one and write it in design.md.`,
    );
    order.push(next);
    left.delete(next);
  }
  const numOf = new Map(order.map((k, i) => [k, i + 1]));

  // ---- rollback texts
  const rollbackLines = [
    ...sectionsOf(ctx, "design.md", /roll|release|deploy|back-?out/i).flatMap((s) =>
      sentences(s.lines).map((x) => ({ ...x, file: "design.md" })),
    ),
    ...sectionsOf(ctx, "data.md", /.*/).flatMap((s) =>
      sentences(s.lines).map((x) => ({ ...x, file: "data.md" })),
    ),
  ].filter((x) => ROLLBACK.test(x.text));
  const allNames = [...units.values()].flatMap((u) => u.names);
  const generic = rollbackLines.filter((x) => !allNames.some((n) => hasWord(x.text, n)));
  const rollbackOf = (u: Unit): Rollback => {
    const own = rollbackLines.filter((x) => u.names.some((n) => hasWord(x.text, n)));
    const fit =
      own.length > 0
        ? own
        : u.kind === "migration"
          ? generic.filter((x) => /migration|schema|column|table/i.test(x.text))
          : u.kind === "code"
            ? generic.filter((x) => !/migration|schema|column|table/i.test(x.text))
            : [];
    if (fit.length === 0)
      return {
        gap: `No rollback step written for ${u.kind === "code" ? u.repo : (u.what[0] ?? u.repo)}: say how to undo it in design.md under "Rollout and rollback"${u.kind === "migration" ? " or in data.md" : ""}.`,
      };
    return {
      text: fit.map((x) => x.text).join(" "),
      source: sortStrings(fit.map((x) => `${x.file}:${x.n}`)).join(", "),
    };
  };

  // ---- service requests: tied to the step they unblock, else before the first step
  const waitsOf = new Map<string, RequestWait[]>();
  const before: RequestWait[] = [];
  for (const r of ctx.requests) {
    const route = r.record ? units.get(`route:${r.record}`) : undefined;
    const taskUnit = !route
      ? [...units.values()].find((u) => r.unblocks.some((t) => u.tasks.includes(t)))
      : undefined;
    const target = route ?? taskUnit;
    const why = route
      ? `it deploys ${r.record}`
      : taskUnit
        ? `it unblocks task ${r.unblocks.join(", ")} in ${taskUnit.repo}`
        : "no step names it, so it is needed before the first step";
    const w = requestWait(ctx, r, why);
    if (r.leadTimeDays === undefined)
      gaps.push(
        `${REQUESTS_FILE}:${r.line}: "${r.heading}" matches no request template, so it has no lead time to forecast.`,
      );
    if (target) waitsOf.set(target.key, [...(waitsOf.get(target.key) ?? []), w]);
    else before.push(w);
  }

  // ---- earliest days, in order
  const beforeReady = before.reduce((d, w) => laterOf(d, w.readyBy ?? ctx.today), ctx.today);
  const earliestOf = new Map<string, string>();
  const steps: PlanStep[] = order.map((k) => {
    const u = units.get(k)!;
    const p = preds.get(k)!;
    const waits = waitsOf.get(k) ?? [];
    const earliest = [
      beforeReady,
      ...waits.map((w) => w.readyBy ?? ctx.today),
      ...p.map((e) => earliestOf.get(e.from) ?? ctx.today),
    ].reduce((a, b) => laterOf(a, b), ctx.today);
    earliestOf.set(k, earliest);
    const why = p.length
      ? sortStrings(p.map((e) => `After step ${numOf.get(e.from)}: ${e.why}.`))
      : [
          u.kind === "migration"
            ? "First: the schema is expanded before any code reads it."
            : u.kind === "gateway-route" || u.kind === "topic"
              ? "Nothing in this change has to be live before it."
              : "No dependency in interfaces.md, data.md or stories.md has to deploy before it.",
        ];
    return {
      n: numOf.get(k)!,
      repo: u.repo,
      kind: u.kind,
      what: u.what,
      why,
      after: sortStrings(p.map((e) => String(numOf.get(e.from))))
        .map(Number)
        .sort((a, b) => a - b),
      rollback: rollbackOf(u),
      waitsOn: waits,
      earliest,
      waitDays: workingDays(ctx.today, earliest),
      sources: sortStrings(u.sources),
    };
  });
  for (const s of steps) if (s.rollback.gap) gaps.push(s.rollback.gap);
  for (const x of external) {
    const caller = externalCaller.get(x.what);
    if (caller && numOf.has(caller)) x.beforeStep = numOf.get(caller)!;
  }

  // ---- release sections from design.md
  const sections: PlanSection[] = SECTIONS.map((d) => {
    const s = sectionOf(ctx, "design.md", d.re);
    if (!s || !s.text) return { name: d.name, gap: d.gap };
    if (d.name === "rollback" && !ROLLBACK.test(s.text))
      return {
        name: d.name,
        heading: s.heading,
        source: s.source,
        gap: `design.md "${s.heading}" gives the order but no way back: say how each step is undone, and when to decide.`,
      };
    return { name: d.name, heading: s.heading, source: s.source, text: s.text };
  });
  for (const s of sections) if (s.gap) gaps.push(s.gap);

  // ---- the order design.md states, against the computed one
  const rollout = sections.find((s) => s.name === "rollout");
  if (rollout?.text) {
    const mentions: { at: number; step: number; name: string }[] = [];
    for (const s of steps) {
      const u = units.get(order[s.n - 1]!)!;
      const words = s.kind === "migration" ? [...u.names, "migration"] : u.names;
      for (const w of words) {
        const at = rollout.text
          .toLowerCase()
          .search(
            new RegExp(`(^|[^a-z0-9_-])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          );
        if (at >= 0) {
          mentions.push({ at, step: s.n, name: w });
          break;
        }
      }
    }
    mentions.sort((a, b) => a.at - b.at);
    for (let i = 0; i + 1 < mentions.length; i++)
      for (let j = i + 1; j < mentions.length; j++)
        if (mentions[i]!.step > mentions[j]!.step)
          notes.push(
            `design.md (${rollout.source}) puts ${mentions[i]!.name} before ${mentions[j]!.name}; the dependencies put ${mentions[j]!.name} first (step ${mentions[j]!.step}).`,
          );
    const named = new Set(mentions.map((x) => x.step));
    for (const s of steps)
      if (!named.has(s.n) && s.kind !== "migration")
        notes.push(`design.md's rollout doesn't mention step ${s.n} (${s.repo}).`);
  }

  for (const [id, why] of [...unplaced].sort(([a], [b]) => cmp(a, b))) gaps.push(why || id);
  const findings: PlanFinding[] = ctx.latest
    .filter((f) => f.finding.lens === "release" && f.finding.state === "open")
    .map((f) => ({
      gate: f.finding.gate,
      id: f.finding.id,
      rule: f.finding.rule,
      severity: f.finding.severity,
      state: f.finding.state,
      summary: f.finding.summary,
      path: f.path,
    }));
  if (ctx.rounds.length === 0)
    notes.push(
      "No critic round has run on this change yet, so the release lens has nothing to add.",
    );

  return {
    change: ctx.change.id,
    title: ctx.change.title,
    state: ctx.change.state,
    today: ctx.today,
    steps,
    before,
    external: external.filter((x, i, a) => a.findIndex((y) => y.what === x.what) === i),
    unplaced: [...unplaced].map(([id, why]) => ({ id, why })).sort((a, b) => cmp(a.id, b.id)),
    sections,
    findings,
    earliest: steps.reduce((d, s) => laterOf(d, s.earliest), beforeReady),
    gaps: [...new Set(gaps)],
    notes: [...new Set(notes)],
  };
}

function placeWhy(ctx: ReleaseContext, id: string, role: string): string {
  return ctx.get("Component", id)
    ? `${id} (${role}) has no repo in the catalog or the repos manifest, so Atticus can't place its deploy.`
    : `${id} (${role}) isn't in the catalog or the repos manifest, so Atticus can't place its deploy.`;
}
