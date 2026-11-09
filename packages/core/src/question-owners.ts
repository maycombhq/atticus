import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { orgPackDirOf, orgPackRelOf } from "./metarepo.js";
import { Roles, type Team } from "./schema/orgpack.js";
import type { Question } from "./schema/question.js";
import { cmpText } from "./identity.js";

/**
 * Route each question to its owner (ADR 0140, Q4): the team that owns the question's repo is the
 * repo manifest's `owner`; roles.yaml's `teams` (version 2) gives the team a name and says who is
 * on it, so `atticus questions list --mine` and the app's Questions page can list a person's own.
 * The person is the metarepo's Git user (ADR 0073). Words, not permissions: anyone can still
 * read and answer any question.
 */

/** The team a question goes to, or why none does. */
export type QuestionOwner = { team: string; name?: string } | { none: string };

/** The teams roles.yaml names, and why they couldn't be read when they couldn't. */
export async function readTeams(root: string): Promise<{
  teams: Team[];
  /** Version 3 (ADR 0189): the organisation's person for each role, when no team names one. */
  defaults?: Record<string, string[]>;
  problem?: string;
}> {
  const rel = `${orgPackRelOf(root)}/roles.yaml`;
  const raw = await readFile(join(orgPackDirOf(root), "roles.yaml"), "utf8").catch(() => undefined);
  if (raw === undefined) return { teams: [] };
  let data: unknown;
  try {
    data = parse(raw);
  } catch (e) {
    return { teams: [], problem: `${rel} can't be read: ${(e as Error).message.split("\n")[0]}` };
  }
  const r = Roles.safeParse(data);
  if (!r.success)
    return {
      teams: [],
      problem: `${rel} isn't valid: ${r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`,
    };
  return { teams: r.data.teams, ...(r.data.defaults ? { defaults: r.data.defaults } : {}) };
}

/** A handle as compared: no leading @, lower case. */
const handleKey = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/** The teams a person is on, by their Git handle. */
export function teamsOfPerson(handle: string, teams: readonly Team[]): Team[] {
  const k = handleKey(handle);
  return teams.filter((t) => t.people.some((p) => handleKey(p) === k));
}

/**
 * Who a question goes to: the team the manifest names as its repo's owner, with the name
 * roles.yaml gives it. A change's own questions, and a repo no manifest lists, have no team.
 */
export function ownerOfQuestion(
  q: Pick<Question, "repo">,
  o: {
    /** Each listed repo's owner, from the repo manifests. */
    owners: ReadonlyMap<string, string>;
    teams: readonly Team[];
    /** The ids of the changes, whose own questions are filed under them. */
    changes?: ReadonlySet<string>;
  },
): QuestionOwner {
  const team = o.owners.get(q.repo);
  if (team) {
    const name = o.teams.find((t) => t.id === team)?.name;
    return { team, ...(name ? { name } : {}) };
  }
  if (o.changes?.has(q.repo))
    return { none: `${q.repo} is a change, not a repo: no team owns its questions` };
  return { none: `no repos.manifest.yaml lists ${q.repo}, so no team owns it` };
}

/**
 * Who a question goes to, a change's people included (ADR 0153, Q4): a change's own question,
 * filed under the change's id, goes to the people its change.yaml names under `owners`, whatever
 * they do on it; every other question goes to its repo's team (`ownerOfQuestion`).
 */
export type QuestionRoute = QuestionOwner | { change: string; people: string[] };

/** Everyone a change.yaml's `owners` names, by handle, once each, sorted. */
export function peopleOfChange(owners: Readonly<Record<string, readonly string[]>>): string[] {
  const seen = new Map<string, string>();
  for (const list of Object.values(owners))
    for (const h of list)
      if (!seen.has(handleKey(h))) seen.set(handleKey(h), h.trim().replace(/^@/, ""));
  // Case-folded first (as people read handles), then by code unit: the same in every locale.
  return [...seen.values()].sort(
    (a, b) => cmpText(a.toLowerCase(), b.toLowerCase()) || cmpText(a, b),
  );
}

export function routeOfQuestion(
  q: Pick<Question, "repo">,
  o: Parameters<typeof ownerOfQuestion>[1] & {
    /** The people of each change (`peopleOfChange`), by change id. */
    changePeople?: ReadonlyMap<string, readonly string[]>;
  },
): QuestionRoute {
  if (!o.owners.has(q.repo) && o.changes?.has(q.repo) && o.changePeople) {
    const people = o.changePeople.get(q.repo) ?? [];
    return people.length
      ? { change: q.repo, people: [...people] }
      : { none: `${q.repo} is a change, and its change.yaml names no owners` };
  }
  return ownerOfQuestion(q, o);
}

/** Whether a question is the person's: they are on its team, or one of its change's people. */
export function isPersonsQuestion(
  handle: string,
  route: QuestionRoute,
  teams: readonly Team[],
): boolean {
  if ("change" in route) return route.people.some((p) => handleKey(p) === handleKey(handle));
  if ("none" in route) return false;
  return teamsOfPerson(handle, teams).some((t) => t.id === route.team);
}

/** The owner in a few words: "team-ledger (Ledger team)", "add-pins's people: ari, sam", or "no owner: why". */
export function ownerWords(o: QuestionRoute): string {
  if ("none" in o) return `no owner: ${o.none}`;
  if ("change" in o) return `${o.change}'s people: ${o.people.join(", ")}`;
  return o.name ? `${o.team} (${o.name})` : o.team;
}
