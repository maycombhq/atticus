import { initiativeStatus, laterOf, readPlan, readView, workingDays } from "@maycombhq/initiatives";
import { readTasks } from "@maycombhq/naysayer";
import type { ReleaseContext } from "./context.js";
import { deploymentPlan, type DeploymentPlan } from "./plan.js";

/**
 * A change's forecast ready-to-release day, worked out from dates alone (no estimates from
 * people, no AI): the service requests' lead times along the deployment plan, and, when the
 * change belongs to an initiative with a plan, that plan's projected finish for the change
 * (the initiatives package's critical path). Open tasks carry no estimates in tasks.md, so they
 * are counted and named but can't move the day: the forecast is the earliest day, not a promise.
 */

export interface ForecastDriver {
  what: string;
  /** The day it is expected done. */
  until: string;
  days: number;
  source: string;
}

export interface ReleaseForecast {
  change: string;
  state: string;
  today: string;
  /** The forecast ready-to-release day; undefined once released. */
  ready?: string;
  basis: "released" | "initiative" | "requests" | "today";
  target?: { date: string; source: string };
  status: "released" | "on-track" | "at-risk" | "late" | "no-target";
  /** Working days from today to the ready day. */
  waitDays: number;
  drivers: ForecastDriver[];
  tasks: { total: number; open: number; done: number; waitingOnRequests: string[] };
  initiative?: {
    id: string;
    title: string;
    status: string;
    targetRelease?: string;
    projectedRelease?: string;
    criticalPath: string[];
    item?: { key: string; milestone: string; due: string; projectedFinish: string; status: string };
  };
  notes: string[];
}

const RELEASED = new Set(["released", "post-release-review", "archived"]);
const MILESTONES = ["release-ready", "released"];

export async function releaseForecast(
  ctx: ReleaseContext,
  plan?: DeploymentPlan,
): Promise<ReleaseForecast> {
  const p = plan ?? (await deploymentPlan(ctx));
  const notes: string[] = [];
  const tasks = readTasks(ctx.files);
  const done = tasks.filter((t) => /\[[xX]\]/.test(t.text));
  const open = tasks.filter((t) => !/\[[xX]\]/.test(t.text));
  const taskNum = (t: { text: string }) => /\[[ xX]?\]\s*(\d+(?:\.\d+)*)/.exec(t.text)?.[1];
  // open tasks a service-request draft says it unblocks
  const waitingOnRequests = ctx.requests
    .flatMap((r) => r.unblocks)
    .filter((n) => open.some((t) => taskNum(t) === n));
  const taskView = {
    total: tasks.length,
    open: open.length,
    done: done.length,
    waitingOnRequests: [...new Set(waitingOnRequests)].sort(),
  };

  if (RELEASED.has(ctx.change.state)) {
    const at = ctx.change.history.filter((h) => h.to === "released").at(-1)?.at;
    return {
      change: ctx.change.id,
      state: ctx.change.state,
      today: ctx.today,
      ...(at ? { ready: at.slice(0, 10) } : {}),
      basis: "released",
      status: "released",
      waitDays: 0,
      drivers: [],
      tasks: taskView,
      notes: at ? [`Released on ${at.slice(0, 10)} (change.yaml history).`] : [],
    };
  }

  const drivers: ForecastDriver[] = [];
  for (const w of [...p.before, ...p.steps.flatMap((s) => s.waitsOn)])
    if (w.readyBy)
      drivers.push({
        what: `${w.requestType}${w.record ? ` for ${w.record}` : ""} (${w.state === "filed" ? `filed${w.number ? ` as ${w.number}` : ""}` : w.state === "waiting" ? "waiting for a person to file it" : "not filed yet"})`,
        until: w.readyBy,
        days: w.waitDays ?? 0,
        source: `${w.source}; lead time ${w.leadTimeDays} working days (${w.leadTimeSource})`,
      });
  let ready = p.earliest;
  let basis: ReleaseForecast["basis"] = drivers.length ? "requests" : "today";
  let target: ReleaseForecast["target"];
  let initiative: ReleaseForecast["initiative"];

  // the initiative the change belongs to, if any, and its plan's projected finish for it
  const view = await readView(ctx.root);
  const owning = view
    .all("Initiative")
    .filter((i) => i.changes.includes(ctx.change.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (owning.length > 1)
    notes.push(
      `${ctx.change.id} is in ${owning.length} initiatives (${owning.map((i) => i.id).join(", ")}); the forecast uses ${owning[0]!.id}.`,
    );
  if (owning[0]) {
    try {
      const st = await initiativeStatus(ctx.root, owning[0].id, { now: new Date(ctx.now) });
      const planned = await readPlan(ctx.root, owning[0].id);
      const milestoneOf = new Map(
        (planned?.items ?? [])
          .filter((i) => i.change === ctx.change.id && MILESTONES.includes(i.milestone ?? ""))
          .map((i) => [i.key, i.milestone!]),
      );
      const item = st.items
        .filter((i) => milestoneOf.has(i.key))
        .sort((a, b) => (a.due < b.due ? -1 : 1))[0];
      initiative = {
        id: st.initiative,
        title: st.title,
        status: st.status,
        ...(st.targetRelease ? { targetRelease: st.targetRelease } : {}),
        ...(st.projectedRelease ? { projectedRelease: st.projectedRelease } : {}),
        criticalPath: st.criticalPath,
        ...(item
          ? {
              item: {
                key: item.key,
                milestone: milestoneOf.get(item.key)!,
                due: item.due,
                projectedFinish: item.projectedFinish,
                status: item.status,
              },
            }
          : {}),
      };
      const src = `initiatives/${st.initiative}/plan.yaml`;
      if (item) {
        drivers.push({
          what: `Initiative ${st.initiative}: ${item.what}`,
          until: item.projectedFinish,
          days: workingDays(ctx.today, item.projectedFinish),
          source: `${src} item ${item.key} (critical path: ${st.criticalPath.join(" → ") || "none"})`,
        });
        ready = laterOf(ready, item.projectedFinish);
        basis = "initiative";
        target = { date: item.due, source: `${src} item ${item.key} due` };
      } else if (st.targetRelease) {
        target = { date: st.targetRelease, source: `${src} targetRelease` };
        notes.push(
          `Initiative ${st.initiative} has no release milestone for ${ctx.change.id}; the target is the initiative's release.`,
        );
      }
      notes.push(...st.notes);
    } catch (e) {
      notes.push(`Initiative ${owning[0].id}: ${(e as Error).message}`);
    }
  } else notes.push(`${ctx.change.id} isn't part of an initiative, so it has no target date.`);

  if (open.length)
    notes.push(
      `${open.length} of ${tasks.length} tasks are open. tasks.md carries no estimates, so they can't move the day: it is the earliest day the dates allow, not a promise.`,
    );
  if (!drivers.length)
    notes.push("Nothing with a lead time stands in the way: no service request waits.");
  for (const g of p.gaps.filter((x) => /no lead time/.test(x))) notes.push(g);

  const status: ReleaseForecast["status"] = !target
    ? "no-target"
    : ctx.today > target.date
      ? "late"
      : ready > target.date
        ? "at-risk"
        : "on-track";
  return {
    change: ctx.change.id,
    state: ctx.change.state,
    today: ctx.today,
    ready,
    basis,
    ...(target ? { target } : {}),
    status,
    waitDays: workingDays(ctx.today, ready),
    drivers: drivers.sort((a, b) => (a.until > b.until ? -1 : a.until < b.until ? 1 : 0)),
    tasks: taskView,
    ...(initiative ? { initiative } : {}),
    notes,
  };
}
