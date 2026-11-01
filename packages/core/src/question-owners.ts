import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { orgPackDirOf, orgPackRelOf } from "./metarepo.js";
import { Roles, type Team } from "./schema/orgpack.js";
import type { Question } from "./schema/question.js";

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
export async function readTeams(root: string): Promise<{ teams: Team[]; problem?: string }> {
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
  return { teams: r.data.teams };
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

/** The owner in a few words: "team-ledger (Ledger team)", or "no owner: why". */
export function ownerWords(o: QuestionOwner): string {
  if ("none" in o) return `no owner: ${o.none}`;
  return o.name ? `${o.team} (${o.name})` : o.team;
}
