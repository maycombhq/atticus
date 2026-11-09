import { fileStepStore, manualAdapter, type Approval, type Notifier } from "@maycombhq/adapters";
import { changeFolder, changeStore } from "@maycombhq/changes";
import {
  loadOrgPack,
  nextOwnersOf,
  orgPackDirOf,
  readTeams,
  type ChangeHandoff,
  type ChangeLifecycle,
} from "@maycombhq/core";
import {
  knowledgeAnswer,
  readKnowledge,
  readSnapshot,
  sectionOf,
  snapshotSources,
  type Passage,
  type PassagePage,
} from "@maycombhq/knowledge";
import { metarepoAdapters, readDeltas, isEmptyDelta } from "@maycombhq/planner";
import { loadRepos } from "@maycombhq/workspace";

/**
 * Roles and the business analyst (ADR 0191), the command line's side: who roles.yaml suggests for
 * a change's roles, telling a hand-off's reviewers and an owner through the notify adapter, and
 * what the organisation's knowledge says to an Ask. Files only; a message goes out only through
 * the adapter runtime.yaml configures, after the person's approval (the click, or --approve).
 */

const handle = (h: string) => h.trim().replace(/^@/, "");

/** The roles a change's owners are named for on its page, in the order a change goes. */
export const OWNER_ROLES = ["product-owner", "architect", "business-analyst", "team-lead"] as const;

export interface OwnerSuggestion {
  role: string;
  people: string[];
  from: { team: string; name?: string; repos: string[] } | { default: true };
}

/**
 * The repos a change is about: the ones it names and its target flows' (the architecture stage
 * names them), and with `systems` its systems' repos too (for whose team owns them).
 */
export async function changeRepos(
  root: string,
  c: ChangeLifecycle,
  o: { systems?: boolean } = {},
): Promise<string[]> {
  const out = new Set(c.touches.repos);
  if (o.systems)
    for (const r of await loadRepos(root).catch(() => []))
      if (r.system && c.systems.includes(r.system)) out.add(r.id);
  const deltas = await readDeltas(changeFolder(root, c.id)).catch(() => ({ deltas: [] }));
  for (const d of deltas.deltas) if (!isEmptyDelta(d)) out.add(d.repo);
  return [...out].sort();
}

/**
 * ADR 0191: who roles.yaml suggests for each role the change doesn't name yet: the people a team
 * that owns the change's repos gives the role (`roles` on the team), else the organisation's
 * default for it. Nothing is written: a person accepts a suggestion.
 */
export async function ownerSuggestions(
  root: string,
  changeId: string,
): Promise<{ change: string; suggestions: OwnerSuggestion[]; note?: string }> {
  const c = await changeStore(root).read(changeId);
  const { teams, defaults, problem } = await readTeams(root);
  const repos = await changeRepos(root, c, { systems: true });
  const owners = new Map((await loadRepos(root).catch(() => [])).map((r) => [r.id, r.owner]));
  const out: OwnerSuggestion[] = [];
  for (const role of OWNER_ROLES) {
    if ((c.owners[role] ?? []).length) continue;
    const found = new Map<
      string,
      { team: string; name?: string; repos: string[]; people: string[] }
    >();
    for (const repo of repos) {
      const t = teams.find((x) => x.id === owners.get(repo));
      const people = t?.roles?.[role];
      if (!t || !people?.length) continue;
      const f = found.get(t.id) ?? {
        team: t.id,
        ...(t.name ? { name: t.name } : {}),
        repos: [],
        people: people.map(handle),
      };
      f.repos.push(repo);
      found.set(t.id, f);
    }
    if (found.size)
      for (const f of found.values())
        out.push({
          role,
          people: f.people,
          from: { team: f.team, ...(f.name ? { name: f.name } : {}), repos: f.repos },
        });
    else if (defaults?.[role]?.length)
      out.push({ role, people: defaults[role]!.map(handle), from: { default: true } });
  }
  const note = out.length
    ? undefined
    : problem
      ? problem
      : OWNER_ROLES.every((r) => (c.owners[r] ?? []).length)
        ? "Every role is named."
        : "roles.yaml names no one for these roles: add a team's roles, or defaults (roles.yaml version 3), and Atticus suggests them here.";
  return { change: c.id, suggestions: out, ...(note ? { note } : {}) };
}

/** How notifications go here: none set, a step for a person (manual), or the adapter. */
export async function notifierFor(
  root: string,
  change: string | undefined,
  given?: Notifier,
): Promise<{ kind: "none" | "manual" | "live"; notify?: Notifier }> {
  if (given) return { kind: "live", notify: given };
  const op = await loadOrgPack(orgPackDirOf(root));
  const cfg = op.runtime.adapters.notify;
  if (!cfg) return { kind: "none" };
  if (cfg.type === "manual") {
    const notify = manualAdapter(
      "notify",
      {
        store: fileStepStore(root),
        root,
        ...(change ? { change } : {}),
        procedures: op.procedures,
      },
      cfg.settings ?? {},
    ) as Notifier;
    return { kind: "manual", notify };
  }
  try {
    const notify = (await metarepoAdapters(root, change ? { change } : {})).notify;
    return notify ? { kind: "live", notify } : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

/**
 * ADR 0191: tell a hand-off's reviewers of the next role that it waits on them, through the
 * notify adapter (manual: a step for a person to tell them). The hand-off's own approval covers
 * it: raising a hand-off asks them to review it. Nothing when notifications aren't set up, or
 * the change names no one of the next role.
 */
export async function notifyHandoffReviewers(
  root: string,
  c: ChangeLifecycle,
  h: ChangeHandoff,
  approval: Approval,
  given?: Notifier,
): Promise<string[]> {
  const next = nextOwnersOf(h.phase, c.owners);
  const people = (next?.people ?? []).filter((p) => h.reviewers.map(handle).includes(p));
  if (!next || !people.length) return [];
  const n = await notifierFor(root, c.id, given);
  if (!n.notify) return [];
  const role = next.role.replace(/-/g, " ");
  const said: string[] = [];
  for (const p of people) {
    try {
      const r = await n.notify.send(
        {
          channel: `@${p}`,
          title: `${c.title}: the ${h.phase} hand-off waits on your review`,
          body: `${c.id} is handed to you as its ${role}. Review the hand-off and approve its pull request on the Git host; merging it approves the gate.`,
          ...(h.pr.url.startsWith("http") ? { link: h.pr.url } : {}),
          mentions: [p],
        },
        approval,
      );
      said.push(
        n.kind === "manual"
          ? `Telling @${p} (${role}) is a step for you (Home › Manual steps): notifications are manual here.`
          : `Told @${p} (${role}) that it waits on their review (${r.id}).`,
      );
    } catch (e) {
      said.push(`Couldn't tell @${p} (${role}): ${(e as Error).message}`);
    }
  }
  return said;
}

/** The pages of every wiki snapshot, and the inputs/ files read now when they have none (ADR 0122). */
export async function knowledgePages(root: string): Promise<PassagePage[]> {
  const out: PassagePage[] = [];
  const ids = await snapshotSources(root).catch(() => [] as string[]);
  for (const id of ids) {
    const snap = await readSnapshot(root, id).catch(() => undefined);
    for (const p of snap?.pages ?? [])
      out.push({ source: id, page: p.pagePath, path: p.path, text: p.text ?? "" });
  }
  if (!ids.includes("inputs")) out.push(...(await inputsPassagePages(root)));
  return out;
}

/** inputs/ as a knowledge source, read as it is now (no snapshot taken yet). */
export async function inputsPassagePages(root: string): Promise<PassagePage[]> {
  try {
    const { inputsPages, INPUTS_SOURCE_ID } = await import("./inputs-knowledge.js");
    const op = await loadOrgPack(orgPackDirOf(root));
    const { pages } = await inputsPages(root, op);
    return pages.map((p) => ({
      source: INPUTS_SOURCE_ID,
      page: p.pagePath,
      path: p.path,
      text: p.content,
    }));
  } catch {
    return [];
  }
}

/** ADR 0191: what the organisation's knowledge says to an Ask, cited (no AI). */
export async function knowledgeAnswerOf(root: string, question: string) {
  const k = await readKnowledge(root, { cacheRoot: root }).catch(() => ({ items: [] }));
  const found = knowledgeAnswer(question, { items: k.items, pages: await knowledgePages(root) });
  return {
    ...found,
    command: `atticus knowledge ask ${JSON.stringify(question)}`,
  };
}

/** One section by its knowledge id (`<source>/<page>#<heading>`), to open it in place. */
export async function passageOf(root: string, id: string): Promise<Passage | undefined> {
  return sectionOf(await knowledgePages(root), id);
}
