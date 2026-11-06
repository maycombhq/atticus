import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  checkedProposals,
  factsDirOf,
  listQuestions,
  parseFactsLines,
  TARGETS_STEP_ID,
  isPersonsQuestion,
  orderQuestions,
  peopleOfChange,
  questionWeights,
  readTeams,
  routeOfQuestion,
  teamsOfPerson,
  type Api,
  type Fact,
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

/**
 * beta.21: a facts file parsed once per version of it (its size and time), not on every
 * request: the Questions page asked for every repo's facts each time it loaded.
 */
const parsed = new Map<string, { size: number; mtimeMs: number; facts: Fact[] }>();
async function factsOnFile(path: string): Promise<Fact[] | undefined> {
  const st = await stat(path).catch(() => undefined);
  if (!st) return undefined;
  const hit = parsed.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.facts;
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const facts = parseFactsLines(text).facts;
  parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, facts });
  return facts;
}

/**
 * Beta.12: the rule each open targets question could be answered with to cover the other open
 * targets questions of its repo whose calls share its path prefix or host (`--match
 * '/accounts/**'`), read from the questions on file and the repos' facts.
 */
export async function ruleOffers(
  root: string,
): Promise<Map<string, { match: string; ids: string[]; calls: number }>> {
  const open = (
    await listQuestions(root, { state: "open" }).catch(() => ({ questions: [] }))
  ).questions.filter((q) => q.askedBy.step === TARGETS_STEP_ID);
  if (open.length < 2) return new Map();
  const facts = new Map<string, Fact[]>();
  for (const repo of new Set(open.map((q) => q.repo))) {
    const f = await factsOnFile(join(factsDirOf(root), `${repo}.jsonl`));
    if (f) facts.set(repo, f);
  }
  // The scanner is loaded only when there is something to offer: listing stays light.
  const { targetRuleOffers } = await import("@maycombhq/scanner");
  return targetRuleOffers(open, (r) => facts.get(r));
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
  const rules = questions.some((q) => q.state === "open" && q.askedBy.step === TARGETS_STEP_ID)
    ? await ruleOffers(root)
    : new Map<string, never>();
  const about: Record<string, About> = {};
  for (const q of questions) {
    const p = q.state === "open" ? proposals.get(q.id) : undefined;
    const rule = q.state === "open" ? rules.get(q.id) : undefined;
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
      ...(rule ? { rule } : {}),
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
