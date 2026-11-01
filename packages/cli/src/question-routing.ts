import { readdir } from "node:fs/promises";
import {
  changesDirOf,
  orderQuestions,
  ownerOfQuestion,
  questionWeights,
  readTeams,
  teamsOfPerson,
  type Api,
  type Question,
} from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";

/**
 * The questions as `atticus questions list`, `atticus next` and the app's Questions page show
 * them (ADR 0140): in the order to ask (what a change in flight rests on first, then the answers
 * that join the most calls, Q3), each with the team it goes to (Q4), and with `mine` only the
 * questions of the teams the person is on. Files only.
 */

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
  const weights = await questionWeights(root, questions);
  const about: Record<string, About> = {};
  for (const q of questions)
    about[q.id] = {
      ...(weights.get(q.id) ?? { restsOn: [], joins: 0 }),
      owner: ownerOfQuestion(q, { owners, teams, changes }),
    };
  let list = orderQuestions(questions, weights);
  let me: Me | undefined;
  if (o.mine !== undefined) {
    const mine = teamsOfPerson(o.mine, teams);
    me = {
      handle: o.mine,
      teams: mine.map((t) => ({ id: t.id, ...(t.name ? { name: t.name } : {}) })),
    };
    const ids = new Set(mine.map((t) => t.id));
    list = list.filter((q) => {
      const w = about[q.id]!.owner;
      return "team" in w && ids.has(w.team);
    });
  }
  return { questions: list, about, ...(me ? { me } : {}), problems };
}
