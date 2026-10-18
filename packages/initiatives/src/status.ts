import { changeStore } from "@maycombhq/changes";
import { LIFECYCLE_STATES, type CatalogRecord, type LifecycleState } from "@maycombhq/core";
import { addWorkingDays, dayOf, laterOf, subtractWorkingDays, workingDays } from "./dates.js";
import {
  InitiativeError,
  manualEvidence,
  readPlan,
  readView,
  writeCurated,
  writePlan,
  type CommitmentRecord,
  type PlanItem,
} from "./store.js";

/** Plain code-point order, the same on every machine. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * Where an initiative stands, computed from dates and change states alone (no estimates from
 * people, no AI). Each plan item is done (its change reached the milestone, its commitment is
 * recorded done, or a person recorded the task done) or not. An unfinished item is assumed
 * to need its whole lead time from the later of today and its planned start (from the day it
 * was recorded as started, if it was), and to start only after the items before it. That
 * gives each item a projected finish; the critical path is the chain of unfinished items with
 * no float that ends the plan latest.
 *
 * - slipped: not done and its due date has passed;
 * - at-risk: not done and projected to finish after its due date;
 * - open: on plan; done: done.
 *
 * A commitment outside the plan (a system card sent to a team) is slipped after its date and
 * at risk in its last two working days.
 */

export type ItemStatus = "done" | "open" | "at-risk" | "slipped";

export interface ItemState {
  key: string;
  kind: PlanItem["kind"];
  what: string;
  party?: string;
  change?: string;
  commitment?: string;
  start: string;
  due: string;
  done: boolean;
  projectedFinish: string;
  /** Working days the item can slip without moving the projected end. */
  float: number;
  critical: boolean;
  status: ItemStatus;
  why: string;
}

export interface CommitmentState {
  id: string;
  what: string;
  party: string;
  neededBy: string;
  /** What the record says. */
  recorded: CommitmentRecord["commitmentStatus"];
  status: ItemStatus;
  why: string;
}

export interface ChangeState {
  id: string;
  /** The change's state, or undefined when it hasn't been created yet. */
  state?: LifecycleState;
  milestones: { milestone: string; due: string; reached: boolean }[];
}

export interface InitiativeStatus {
  initiative: string;
  title: string;
  journey: string;
  target?: string;
  targetRelease?: string;
  today: string;
  projectedRelease?: string;
  status: "on-track" | "at-risk" | "slipped" | "done" | "not-planned";
  items: ItemState[];
  criticalPath: string[];
  commitments: CommitmentState[];
  changes: ChangeState[];
  notes: string[];
}

const ORDER = LIFECYCLE_STATES as readonly string[];
const REACHED: Record<string, LifecycleState> = {
  design: "plan",
  build: "qa",
  "release-ready": "release-ready",
  released: "released",
};

/** True when a change in `state` has passed `milestone`. A returned change has passed nothing. */
export function reached(state: LifecycleState | undefined, milestone: string): boolean {
  if (!state || state === "returned" || state === "draft") return false;
  const need = REACHED[milestone];
  if (!need) return false;
  const rank = (s: string) =>
    s === "post-release-review" ? ORDER.indexOf("released") + 0.5 : ORDER.indexOf(s);
  return rank(state) >= rank(need);
}

export async function initiativeStatus(
  root: string,
  id: string,
  o: { now?: Date } = {},
): Promise<InitiativeStatus> {
  const today = dayOf(o.now ?? new Date());
  const view = await readView(root);
  const initiative = view.get("Initiative", id);
  if (!initiative) throw new InitiativeError(`There is no initiative ${id}.`, "not-found");
  const plan = await readPlan(root, id);
  const store = changeStore(root);
  const notes: string[] = [];
  const changeStates = new Map<string, LifecycleState | undefined>();
  for (const c of initiative.changes) {
    try {
      changeStates.set(c, (await store.tryRead(c))?.state);
    } catch (e) {
      changeStates.set(c, undefined);
      notes.push(`Change ${c}: ${(e as Error).message}`);
    }
  }
  const commitmentRecords = view.all("Commitment").filter((c) => c.initiative === id);
  const recordOf = new Map(commitmentRecords.map((c) => [c.id, c]));

  const items: ItemState[] = [];
  let projectedRelease: string | undefined;
  if (plan) {
    const isDone = (i: PlanItem): boolean => {
      if (i.kind === "change") return reached(changeStates.get(i.change!), i.milestone!);
      if (i.commitment) return recordOf.get(i.commitment)?.commitmentStatus === "done";
      return !!plan.done[i.key];
    };
    const byKey = new Map(plan.items.map((i) => [i.key, i]));
    const succ = new Map<string, string[]>(plan.items.map((i) => [i.key, []]));
    for (const i of plan.items) for (const a of i.after) succ.get(a)?.push(i.key);
    // forward pass in topological order (plan order is already topological per template)
    const order = topo(plan.items);
    const ef = new Map<string, string>();
    const done = new Map<string, boolean>();
    for (const k of order) {
      const i = byKey.get(k)!;
      const d = isDone(i);
      done.set(k, d);
      if (d) {
        ef.set(k, today);
        continue;
      }
      const preds = i.after.map((a) => ef.get(a)!).filter(Boolean);
      const startFrom = plan.started[k] ?? laterOf(today, i.start);
      const es = preds.reduce((m, p) => laterOf(m, p), startFrom);
      ef.set(k, laterOf(addWorkingDays(es, i.days), today));
    }
    const open = order.filter((k) => !done.get(k));
    const end =
      open
        .map((k) => ef.get(k)!)
        .sort()
        .at(-1) ?? today;
    projectedRelease = end;
    // backward pass for float
    const lf = new Map<string, string>();
    for (const k of [...order].reverse()) {
      if (done.get(k)) continue;
      const after = succ.get(k)!.filter((s) => !done.get(s));
      const latest = after.length
        ? after.map((s) => subtractWorkingDays(lf.get(s)!, byKey.get(s)!.days)).sort()[0]!
        : end;
      lf.set(k, latest);
    }
    for (const i of plan.items) {
      const d = done.get(i.key)!;
      const finish = ef.get(i.key)!;
      const float = d ? 0 : workingDays(finish, lf.get(i.key)!);
      const status: ItemStatus = d
        ? "done"
        : today > i.due
          ? "slipped"
          : finish > i.due
            ? "at-risk"
            : "open";
      const lateBefore = i.after.filter((a) => !done.get(a) && ef.get(a)! > byKey.get(a)!.due);
      const why =
        status === "done"
          ? "Done."
          : status === "slipped"
            ? `Due ${i.due} and not done.`
            : status === "at-risk"
              ? `Projected to finish ${finish}, after its due date ${i.due}${lateBefore.length ? `, because ${lateBefore.join(", ")} ${lateBefore.length === 1 ? "is" : "are"} late` : ""}.`
              : `On plan: due ${i.due}.`;
      items.push({
        key: i.key,
        kind: i.kind,
        what: i.what,
        ...(i.party ? { party: i.party } : {}),
        ...(i.change ? { change: i.change } : {}),
        ...(i.commitment ? { commitment: i.commitment } : {}),
        start: i.start,
        due: i.due,
        done: d,
        projectedFinish: finish,
        float,
        critical: !d && float <= 0,
        status,
        why,
      });
    }
  } else notes.push(`Initiative ${id} has no plan yet: run initiative plan.`);

  // the critical path: from the item that ends last, back through critical items that drive it
  const criticalPath: string[] = [];
  const stateOf = new Map(items.map((i) => [i.key, i]));
  const planByKey = new Map((plan?.items ?? []).map((i) => [i.key, i]));
  const pick = (keys: string[]) =>
    keys
      .map((k) => stateOf.get(k)!)
      .filter((s) => s && s.critical)
      .sort((a, b) =>
        a.projectedFinish === b.projectedFinish
          ? cmp(a.key, b.key)
          : a.projectedFinish < b.projectedFinish
            ? 1
            : -1,
      )[0];
  const sinks = items.filter(
    (i) => !items.some((j) => planByKey.get(j.key)?.after.includes(i.key)),
  );
  let cur = pick(sinks.map((s) => s.key));
  while (cur) {
    criticalPath.unshift(cur.key);
    cur = pick(planByKey.get(cur.key)!.after);
  }

  const commitments: CommitmentState[] = commitmentRecords.map((c) => {
    const item = items.find((i) => i.commitment === c.id);
    let status: ItemStatus;
    let why: string;
    if (c.commitmentStatus === "done") [status, why] = ["done", "Done."];
    else if (item) [status, why] = [item.status, item.why];
    else if (today > c.neededBy)
      [status, why] = ["slipped", `Needed by ${c.neededBy} and not done.`];
    else if (workingDays(today, c.neededBy) <= 2)
      [status, why] = ["at-risk", `Needed by ${c.neededBy}: two working days or less left.`];
    else [status, why] = ["open", `Needed by ${c.neededBy}.`];
    return {
      id: c.id,
      what: c.what,
      party: c.party,
      neededBy: c.neededBy,
      recorded: c.commitmentStatus,
      status,
      why,
    };
  });

  const changes: ChangeState[] = initiative.changes.map((c) => {
    const state = changeStates.get(c);
    return {
      id: c,
      ...(state ? { state } : {}),
      milestones: (plan?.items ?? [])
        .filter((i) => i.change === c)
        .map((i) => ({
          milestone: i.milestone!,
          due: i.due,
          reached: reached(state, i.milestone!),
        })),
    };
  });

  const target = plan?.targetRelease ?? initiative.targetRelease;
  const allDone = items.length > 0 && items.every((i) => i.done);
  const status: InitiativeStatus["status"] = !plan
    ? "not-planned"
    : allDone
      ? "done"
      : target && today > target
        ? "slipped"
        : items.some((i) => i.status === "slipped" || i.status === "at-risk") ||
            (target && projectedRelease && projectedRelease > target) ||
            commitments.some((c) => c.status === "slipped" || c.status === "at-risk")
          ? "at-risk"
          : "on-track";
  return {
    initiative: id,
    title: initiative.title,
    journey: initiative.journey,
    ...(plan ? { target: plan.target } : {}),
    ...(target ? { targetRelease: target } : {}),
    today,
    ...(projectedRelease ? { projectedRelease } : {}),
    status,
    items,
    criticalPath,
    commitments,
    changes,
    notes,
  };
}

/** Plan order made strictly topological (it already is for plans Atticus writes). */
function topo(items: PlanItem[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byKey = new Map(items.map((i) => [i.key, i]));
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const a of byKey.get(k)?.after ?? []) visit(a);
    out.push(k);
  };
  for (const i of items) visit(i.key);
  return out;
}

/** Record a commitment's status (done, at-risk, slipped, open) as the person who knows. */
export async function recordCommitment(
  root: string,
  id: string,
  o: { status: CommitmentRecord["commitmentStatus"]; by: string },
): Promise<{ commitment: CommitmentRecord; written: string }> {
  const view = await readView(root);
  const c = view.get("Commitment", id);
  if (!c) throw new InitiativeError(`There is no commitment ${id}.`, "not-found");
  const by = o.by.replace(/^@/, "");
  const evidence = c.evidence.some((e) => e.source === "manual" && e.by === by)
    ? c.evidence
    : [...c.evidence, ...manualEvidence(by)];
  const updated: CommitmentRecord = { ...c, commitmentStatus: o.status, evidence };
  return { commitment: updated, written: await writeCurated(root, updated as CatalogRecord) };
}

/** Record a plan task as done, or an item as started (a request sent, a team asked), by a person. */
export async function recordPlanItem(
  root: string,
  id: string,
  key: string,
  o: { done?: boolean; started?: string; by: string; now?: Date },
): Promise<string> {
  const plan = await readPlan(root, id);
  if (!plan) throw new InitiativeError(`Initiative ${id} has no plan yet.`, "not-found");
  if (!plan.items.some((i) => i.key === key))
    throw new InitiativeError(`The plan of ${id} has no item ${key}.`, "not-found");
  const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (o.done) plan.done[key] = { at, by: o.by.replace(/^@/, "") };
  if (o.started) plan.started[key] = o.started;
  return writePlan(root, plan);
}
