import { loadOrgPack, orgPackDirOf, type CatalogRecord } from "@maycombhq/core";
import { readServiceRequestExports } from "@maycombhq/intake";
import { isIsoDay, subtractWorkingDays, weekdayOnOrBefore } from "./dates.js";
import { loadJourneys, stepsOf, type JourneyStep, type PartyRole } from "./journeys.js";
import { leadTimeFor } from "./leadtimes.js";
import {
  InitiativeError,
  manualEvidence,
  readPlan,
  readView,
  writeCurated,
  writePlan,
  type CatalogView,
  type CommitmentRecord,
  type InitiativeRecord,
  type PartyRecord,
  type PlanFile,
  type PlanItem,
} from "./store.js";

/** Plain code-point order, the same on every machine. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * Plan a journey: expand the journey's steps for this initiative (one item per caller when a
 * step is per caller, and so on), give each the lead time its party, past requests or request
 * template say, and schedule backwards from the target release: the last items are due on the
 * release day, and every item is due when the earliest item after it must start. Commitments
 * and requests become Commitment records with those dates; change steps name the change each
 * system needs (proposed, with the command that creates it). Deterministic: the same catalog,
 * org pack and inputs give the same plan.
 */

export interface PlanJourneyOptions {
  /** The system the journey is about: the vendor, the new partner, the system that changes, moves or retires. */
  target?: string;
  /** YYYY-MM-DD. Default: the initiative's targetRelease. */
  targetRelease?: string;
  /** The systems a new integration connects (journeys with steps per "systems"). */
  systems?: string[];
  by: string;
  now?: Date;
  /** Compute and return the plan; write nothing. */
  dryRun?: boolean;
}

export interface ProposedChange {
  id: string;
  title: string;
  type: string;
  system?: string;
  /** The command a person runs to start it. */
  command: string;
}

export interface PlanResult {
  initiative: InitiativeRecord;
  plan: PlanFile;
  commitments: CommitmentRecord[];
  changes: ProposedChange[];
  notes: string[];
  written: string[];
}

const nowIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^party\./, "")
    .replace(/[^a-z0-9]+/g, "");

/** The system a record id belongs to: a system itself, or a component's system. */
export function systemOf(view: CatalogView, id: string): string | undefined {
  if (view.get("System", id)) return id;
  return view.get("Component", id)?.system;
}

/** Systems that call `target` (from interfaces), and systems it calls, sorted. */
export function neighbours(
  view: CatalogView,
  target: string,
): { callers: string[]; callees: string[] } {
  const callers = new Set<string>();
  const callees = new Set<string>();
  for (const i of view.all("Interface")) {
    if (i.status === "retired") continue;
    const from = systemOf(view, i.from);
    const to = systemOf(view, i.to);
    if (!from || !to || from === to) continue;
    if (to === target) callers.add(from);
    if (from === target) callees.add(to);
  }
  return { callers: [...callers].sort(), callees: [...callees].sort() };
}

const partiesOf = (view: CatalogView, system: string) =>
  view
    .all("Party")
    .filter((p) => p.status !== "retired" && p.systems.includes(system))
    .sort((a, b) => cmp(a.id, b.id));

/** The party a step's role names, for the target or one system. */
export function partyFor(
  view: CatalogView,
  role: PartyRole,
  o: { target: string; system?: string; approvers?: string[] },
): PartyRecord | undefined {
  const parties = view.all("Party").filter((p) => p.status !== "retired");
  if (role.startsWith("party:")) return view.get("Party", role.slice("party:".length));
  switch (role) {
    case "vendor":
      return partiesOf(view, o.target).find((p) => p.partyKind === "vendor");
    case "target-owner":
      return partiesOf(view, o.target)[0];
    case "caller-owners":
    case "callee-owners":
      return o.system ? partiesOf(view, o.system)[0] : undefined;
    case "platform":
      return parties
        .sort((a, b) => cmp(a.id, b.id))
        .find((p) => /platform/i.test(`${p.id} ${p.name} ${p.owner ?? ""}`));
    case "approver": {
      const want = new Set((o.approvers ?? []).map(norm));
      return parties
        .sort((a, b) => cmp(a.id, b.id))
        .find(
          (p) =>
            want.has(norm(p.id)) || want.has(norm(p.name)) || (p.owner && want.has(norm(p.owner))),
        );
    }
    default:
      return undefined;
  }
}

const fill = (text: string, v: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

export async function planJourney(
  root: string,
  initiativeId: string,
  o: PlanJourneyOptions,
): Promise<PlanResult> {
  const now = o.now ?? new Date();
  const view = await readView(root);
  const initiative = view.get("Initiative", initiativeId);
  if (!initiative)
    throw new InitiativeError(`There is no initiative ${initiativeId}.`, "not-found");
  const previous = await readPlan(root, initiativeId);
  const target = o.target ?? previous?.target;
  if (!target)
    throw new InitiativeError("Name the system the journey is about (--target <system>).", "usage");
  if (!systemOf(view, target))
    throw new InitiativeError(`${target} is not a system or component in the catalog.`, "usage");
  const targetSystem = systemOf(view, target)!;
  const release = o.targetRelease ?? initiative.targetRelease ?? previous?.targetRelease;
  if (!release || !isIsoDay(release))
    throw new InitiativeError("Give the target release as YYYY-MM-DD (--release).", "usage");

  const { journeys, problems } = await loadJourneys(root);
  const journey = journeys.get(initiative.journey);
  if (!journey)
    throw new InitiativeError(`No journey ${initiative.journey}: ${problems.join("; ")}`);
  const orgPack = await loadOrgPack(orgPackDirOf(root));
  const exports = await readServiceRequestExports({ root });
  const notes: string[] = [...problems];

  const { callers, callees } = neighbours(view, targetSystem);
  const named = (o.systems ?? []).map((s) => systemOf(view, s) ?? s);
  for (const s of o.systems ?? [])
    if (!systemOf(view, s))
      notes.push(`${s} is not in the catalog; its items use the id as given.`);
  const scope: Record<JourneyStep["per"], (string | undefined)[]> = {
    once: [undefined],
    target: [targetSystem],
    callers,
    callees,
    systems: named,
  };
  const nameOf = (s: string) => view.get("System", s)?.name ?? s;
  const steps = stepsOf(journey);

  // ---- expand steps into items
  interface Draft extends Omit<PlanItem, "start" | "due"> {
    order: number;
  }
  const items: Draft[] = [];
  const itemsOfStep = new Map<string, Draft[]>();
  const skipped = new Set<string>();
  steps.forEach((step, order) => {
    const systems = scope[step.per];
    if (!systems.length) {
      skipped.add(step.id);
      notes.push(
        `Step ${step.id} is per ${step.per.replace(/s$/, "")} and ${nameOf(targetSystem)} has none: left out.`,
      );
      itemsOfStep.set(step.id, []);
      return;
    }
    const made: Draft[] = [];
    for (const system of systems) {
      const vars = {
        initiative: initiative.title,
        target: targetSystem,
        targetName: nameOf(targetSystem),
        system: system ?? targetSystem,
        systemName: system ? nameOf(system) : nameOf(targetSystem),
      };
      const template = step.template
        ? orgPack.serviceRequests.find((t) => t.id === step.template)
        : undefined;
      if (step.kind === "request" && !template)
        notes.push(
          `Step ${step.id} needs the request template ${step.template}, which the org pack doesn't have; the journey default is used.`,
        );
      const party = step.party
        ? partyFor(view, step.party, {
            target: targetSystem,
            ...(system ? { system } : {}),
            approvers: template?.approvers ?? [],
          })
        : undefined;
      if (step.party && !party)
        notes.push(
          `No party for step ${step.id}${system ? ` (${system})` : ""} (${step.party}): add a Party record to catalog/curated/party/ and plan again.`,
        );
      const lt = leadTimeFor(step, party, {
        templates: orgPack.serviceRequests,
        requests: exports.requests,
        journey: journey.id,
      });
      const key = step.per === "once" ? step.id : `${step.id}.${system}`;
      const change =
        step.kind === "change"
          ? system
            ? `${initiative.id}-${system}`
            : initiative.id
          : undefined;
      const d: Draft = {
        order,
        key,
        step: step.id,
        phase: step.phase,
        kind: step.kind,
        what: fill(step.what, vars),
        ...(system && step.per !== "once" ? { system } : {}),
        ...(party ? { party: party.id } : {}),
        ...((step.kind === "commitment" || step.kind === "request") && party
          ? { commitment: `${initiative.id}.${key}` }
          : {}),
        ...(change ? { change } : {}),
        ...(step.milestone ? { milestone: step.milestone } : {}),
        ...(step.template ? { template: step.template } : {}),
        ...(step.owner ? { owner: step.owner } : {}),
        days: lt.days,
        leadTime: lt.source,
        after: [],
      };
      made.push(d);
      items.push(d);
    }
    itemsOfStep.set(step.id, made);
  });

  // ---- dependencies: the same system's item when there is one, else every item of the step
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const predecessorsOf = (stepId: string, seen = new Set<string>()): string[] => {
    const out: string[] = [];
    for (const a of stepById.get(stepId)?.after ?? []) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (skipped.has(a)) out.push(...predecessorsOf(a, seen));
      else out.push(a);
    }
    return out;
  };
  for (const d of items) {
    const after: string[] = [];
    for (const a of predecessorsOf(d.step)) {
      const its = itemsOfStep.get(a) ?? [];
      const same = d.system ? its.filter((x) => x.system === d.system) : [];
      for (const x of same.length ? same : its) if (!after.includes(x.key)) after.push(x.key);
    }
    d.after = after;
  }

  // ---- schedule backwards from the release
  const successors = new Map<string, Draft[]>(items.map((d) => [d.key, []]));
  for (const d of items) for (const a of d.after) successors.get(a)!.push(d);
  const releaseDay = weekdayOnOrBefore(release);
  if (releaseDay !== release)
    notes.push(`${release} is a weekend day; the plan ends on ${releaseDay}.`);
  const dates = new Map<string, { start: string; due: string }>();
  const byKey = new Map(items.map((d) => [d.key, d]));
  const remaining = new Map(items.map((d) => [d.key, successors.get(d.key)!.length]));
  // reverse topological order: an item once every item after it has its dates
  const ready = items.filter((d) => remaining.get(d.key) === 0);
  while (ready.length) {
    ready.sort((a, b) => b.order - a.order || (a.key < b.key ? 1 : -1));
    const d = ready.shift()!;
    const succ = successors.get(d.key)!;
    const due = succ.length ? succ.map((s) => dates.get(s.key)!.start).sort()[0]! : releaseDay;
    dates.set(d.key, { start: subtractWorkingDays(due, d.days), due });
    for (const a of d.after) {
      remaining.set(a, remaining.get(a)! - 1);
      if (remaining.get(a) === 0) ready.push(byKey.get(a)!);
    }
  }
  const today = now.toISOString().slice(0, 10);
  const planItems: PlanItem[] = items
    .sort((a, b) => a.order - b.order || cmp(a.key, b.key))
    .map(({ order: _o, ...d }) => ({ ...d, ...dates.get(d.key)! }));
  const late = planItems.filter((i) => i.start < today);
  if (late.length)
    notes.push(
      `Already behind on the day it is planned: ${late.map((i) => `${i.key} (should have started ${i.start})`).join(", ")}.`,
    );

  const plan: PlanFile = {
    schemaVersion: 1,
    initiative: initiative.id,
    journey: journey.id,
    journeySource: journey.source,
    target: targetSystem,
    targetRelease: release,
    createdAt: nowIso(now),
    by: o.by.replace(/^@/, ""),
    items: planItems,
    done: previous?.done ?? {},
    started: previous?.started ?? {},
    notes,
  };

  // ---- commitments
  const keyToRef = (k: string) => byKey.get(k)?.change ?? k;
  const commitments: CommitmentRecord[] = [];
  for (const i of planItems) {
    if (!i.commitment || !i.party) continue;
    const party = view.get("Party", i.party)!;
    const existing = view.get("Commitment", i.commitment);
    const blocks = [...new Set(successors.get(i.key)!.map((s) => keyToRef(s.key)))];
    commitments.push({
      schemaVersion: 2,
      kind: "Commitment",
      id: i.commitment,
      status: "current",
      confidence: "asserted",
      evidence: existing?.evidence ?? manualEvidence(o.by),
      initiative: initiative.id,
      party: party.id,
      what: i.what,
      owner: party.owner ?? party.name,
      neededBy: i.due,
      blocks,
      commitmentStatus: existing?.commitmentStatus === "done" ? "done" : "open",
    });
  }

  // ---- proposed changes
  const changes: ProposedChange[] = [];
  for (const i of planItems) {
    if (!i.change || changes.some((c) => c.id === i.change)) continue;
    const step = stepById.get(i.step)!;
    const title = `${initiative.title}: ${i.system ? nameOf(i.system) : nameOf(targetSystem)}`;
    changes.push({
      id: i.change,
      title,
      type: step.changeType,
      ...(i.system ? { system: i.system } : {}),
      command: `atticus change new "${title}" --type ${step.changeType} --id ${i.change}${i.system ? ` --system ${i.system}` : ""}`,
    });
  }

  const updated: InitiativeRecord = {
    ...initiative,
    changes: [...new Set([...initiative.changes, ...changes.map((c) => c.id)])],
    parties: [
      ...new Set([...initiative.parties, ...planItems.flatMap((i) => (i.party ? [i.party] : []))]),
    ],
    commitments: [...new Set([...initiative.commitments, ...commitments.map((c) => c.id)])],
    targetRelease: release,
  };

  const written: string[] = [];
  if (!o.dryRun) {
    written.push(await writePlan(root, plan));
    for (const c of commitments) written.push(await writeCurated(root, c as CatalogRecord));
    written.push(await writeCurated(root, updated as CatalogRecord));
  }
  return { initiative: updated, plan, commitments, changes, notes, written };
}
