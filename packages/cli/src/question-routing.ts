import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  checkedProposals,
  isPersonsQuestion,
  orderQuestions,
  peopleOfChange,
  questionWeights,
  readTeams,
  routeOfQuestion,
  teamsOfPerson,
  type Api,
  type Question,
} from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";

/**
 * The questions as `atticus questions list`, `atticus next` and the app's Questions page show
 * them (ADR 0140): in the order to ask (what a change in flight rests on first, then the answers
 * that join the most calls, Q3), each with the team it goes to (Q4), and with `mine` only the
 * questions of the teams the person is on. A change's own questions go to the change's people,
 * its change.yaml's `owners` (ADR 0153). Files only.
 */

/** The people of a change, from its change.yaml's `owners`; none when it doesn't read. */
async function changePeopleOf(root: string, id: string): Promise<string[]> {
  const text = await readFile(join(changesDirOf(root), id, "change.yaml"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return [];
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return [];
  }
  const owners = (data as { owners?: unknown } | null)?.owners;
  if (!owners || typeof owners !== "object" || Array.isArray(owners)) return [];
  const lists: Record<string, string[]> = {};
  for (const [role, v] of Object.entries(owners as Record<string, unknown>))
    if (Array.isArray(v))
      lists[role] = v.filter((h): h is string => typeof h === "string" && !!h.trim());
  return peopleOfChange(lists);
}

type About = NonNullable<Api.QuestionListT["about"]>[string];
export type Me = NonNullable<Api.QuestionListT["me"]>;

export interface RoutedQuestions {
  questions: Question[];
  about: Record<string, About>;
  /** With `mine`: who the person is and their teams. */
  me?: Me;
  /** roles.yaml or a manifest that couldn't be read. */
  problems: { file: string; message: string }[];
}

export async function routeQuestions(
  root: string,
  questions: readonly Question[],
  o: { mine?: string } = {},
): Promise<RoutedQuestions> {
  const problems: RoutedQuestions["problems"] = [];
  const owners = new Map<string, string>();
  try {
    for (const r of await loadRepos(root)) owners.set(r.id, r.owner);
  } catch (e) {
    problems.push({
      file: "org-pack/profiles",
      message: (e as Error).message.split("\n")[0]!,
    });
  }
  const { teams, problem } = await readTeams(root);
  if (problem) problems.push({ file: "org-pack/roles.yaml", message: problem });
  const changes = new Set(
    await readdir(changesDirOf(root), { withFileTypes: true }).then(
      (d) => d.filter((x) => x.isDirectory()).map((x) => x.name),
      () => [] as string[],
    ),
  );
  const changePeople = new Map<string, string[]>();
  for (const id of new Set(questions.map((q) => q.repo)))
    if (changes.has(id)) changePeople.set(id, await changePeopleOf(root, id));
  const weights = await questionWeights(root, questions);
  // ADR 0144 (Q5): an open question's proposed answer, only once every line it cites holds.
  const proposals = new Map(
    (await checkedProposals(root).catch(() => []))
      .filter((p) => p.ok && p.proposal)
      .map((p) => [p.id, { ...p.proposal!, file: p.file }] as const),
  );
  const about: Record<string, About> = {};
  for (const q of questions) {
    const p = q.state === "open" ? proposals.get(q.id) : undefined;
    about[q.id] = {
      ...(weights.get(q.id) ?? { restsOn: [], joins: 0 }),
      owner: routeOfQuestion(q, { owners, teams, changes, changePeople }),
      ...(p
        ? {
            proposal: {
              answer: p.answer,
              why: p.why,
              cites: p.cites,
              by: p.by,
              at: p.at,
              file: p.file,
            },
          }
        : {}),
    };
  }
  let list = orderQuestions(questions, weights);
  let me: Me | undefined;
  if (o.mine !== undefined) {
    const mine = teamsOfPerson(o.mine, teams);
    me = {
      handle: o.mine,
      teams: mine.map((t) => ({ id: t.id, ...(t.name ? { name: t.name } : {}) })),
    };
    const handle = o.mine;
    list = list.filter((q) => isPersonsQuestion(handle, about[q.id]!.owner, teams));
  }
  return { questions: list, about, ...(me ? { me } : {}), problems };
}
