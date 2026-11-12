import {
  fileStepStore,
  manualAdapter,
  type AdapterFactories,
  type Approval,
  type FallbackEvent,
  type Notifier,
} from "@maycombhq/adapters";
import { changeFolder, changeStore } from "@maycombhq/changes";
import {
  handleKey,
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
  syncSources,
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

/**
 * How notifications go here: none set, a step for a person (manual), or the adapter. Beta.27
 * review, final round: a live notifier that can't be reached or has no credentials falls back to
 * a manual step (ADR 0032). One that couldn't start is said as manual, with `fallback` the reason;
 * one that falls back on a call puts the event in `fallbacks` as it happens, so a caller never
 * says "sent" for what became a step.
 */
export async function notifierFor(
  root: string,
  change: string | undefined,
  given?: Notifier,
  o: { factories?: AdapterFactories } = {},
): Promise<{
  kind: "none" | "manual" | "live";
  notify?: Notifier;
  /** Why a live notifier is a manual step instead (it couldn't start). */
  fallback?: string;
  /** The notifier's fallbacks to a manual step on a call, as they happen. */
  fallbacks: FallbackEvent[];
}> {
  const fallbacks: FallbackEvent[] = [];
  if (given) return { kind: "live", notify: given, fallbacks };
  const op = await loadOrgPack(orgPackDirOf(root));
  const cfg = op.runtime.adapters.notify;
  if (!cfg) return { kind: "none", fallbacks };
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
    return { kind: "manual", notify, fallbacks };
  }
  try {
    const notify = (
      await metarepoAdapters(root, {
        ...(change ? { change } : {}),
        ...(o.factories ? { factories: o.factories } : {}),
        onFallback: (e) => {
          if (e.kind === "notify") fallbacks.push(e);
        },
      })
    ).notify;
    if (!notify) return { kind: "none", fallbacks };
    const started = fallbacks.find((e) => e.method === "connect");
    if (started) {
      fallbacks.length = 0;
      return { kind: "manual", notify, fallback: fallbackWords(started), fallbacks };
    }
    return { kind: "live", notify, fallbacks };
  } catch {
    return { kind: "none", fallbacks };
  }
}

/** A notifier's fallback to a manual step, in words: what failed, its code and what it said. */
export function fallbackWords(e: FallbackEvent): string {
  return `the notify adapter ${e.method === "connect" ? "couldn't start" : "couldn't send it"} (${e.code}: ${e.message})`;
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
  o: { factories?: AdapterFactories } = {},
): Promise<string[]> {
  const { customRoles } = await import("./change-roles.js");
  const next = nextOwnersOf(h.phase, c.owners, await customRoles(root));
  // ADR 0191 review: an owner is a reviewer as handles compare (any case, with or without @).
  const reviewing = new Set(h.reviewers.map(handleKey));
  const people = (next?.people ?? []).filter((p) => reviewing.has(handleKey(p))).map(handle);
  if (!next || !people.length) return [];
  const n = await notifierFor(root, c.id, given, o);
  if (!n.notify) return [];
  const role = next.role.replace(/-/g, " ");
  const said: string[] = [];
  for (const p of people) {
    try {
      const before = n.fallbacks.length;
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
      // Review of the fix: a live notifier that couldn't start, or fell back on this send, made
      // a step for the person: nobody was told.
      const fell =
        n.fallback ??
        (n.fallbacks.length > before ? fallbackWords(n.fallbacks.at(-1)!) : undefined);
      said.push(
        fell
          ? `Telling @${p} (${role}) is a step for you (Home › Manual steps): ${fell}.`
          : n.kind === "manual"
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

/**
 * inputs/ as a knowledge source, read as it is now (no snapshot taken yet). Each file is checked
 * as `atticus sources sync` checks it (ADR 0122): a page above the classification limit, under
 * view restrictions or with front matter that doesn't read is listed by a sync, never read here.
 */
export async function inputsPassagePages(root: string): Promise<PassagePage[]> {
  try {
    const { inputsPages, INPUTS_SOURCE, INPUTS_SOURCE_ID } = await import("./inputs-knowledge.js");
    const op = await loadOrgPack(orgPackDirOf(root));
    const { pages } = await inputsPages(root, op);
    const sync = await syncSources({
      root,
      orgPack: { ...op, sources: { ...op.sources, wikis: [INPUTS_SOURCE] } },
      orgPackDir: orgPackDirOf(root),
      adaptersById: { [INPUTS_SOURCE_ID]: { pages: async () => pages } },
    });
    const content = new Map(pages.map((p) => [`${p.path}\0${p.pagePath}`, p.content]));
    return sync.pages
      .filter((p) => p.source === INPUTS_SOURCE_ID)
      .map((p) => ({
        source: INPUTS_SOURCE_ID,
        page: p.pagePath,
        path: p.path,
        text: p.text ?? content.get(`${p.path}\0${p.pagePath}`) ?? "",
      }));
  } catch {
    return [];
  }
}

/**
 * A question or phrase as one argument a person can paste into bash, zsh, PowerShell or cmd.
 * The text may come from a link (#/explore?ask=...), so only letters, digits, spaces and plain
 * punctuation are kept inside double quotes: nothing in it can expand, run or end the quote.
 */
export function pastableArg(text: string): string {
  const safe = text
    .replace(/[^\p{L}\p{N} .,?:/@#+=_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `"${safe}"`;
}

/** ADR 0191: what the organisation's knowledge says to an Ask, cited (no AI). */
export async function knowledgeAnswerOf(root: string, question: string) {
  const k = await readKnowledge(root, { cacheRoot: root }).catch(() => ({ items: [] }));
  const found = knowledgeAnswer(question, { items: k.items, pages: await knowledgePages(root) });
  return {
    ...found,
    command: `atticus knowledge ask ${pastableArg(question)}`,
  };
}

/** One section by its knowledge id (`<source>/<page>#<heading>`), to open it in place. */
export async function passageOf(root: string, id: string): Promise<Passage | undefined> {
  return sectionOf(await knowledgePages(root), id);
}
