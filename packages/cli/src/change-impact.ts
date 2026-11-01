import { readTeams, type Api, type QuestionOwner, type Team } from "@maycombhq/core";
import { changeImpact, loadEstate } from "@maycombhq/planner";
import { loadRepos } from "@maycombhq/workspace";
import { targetFlowsOf } from "./change-map.js";
import type { Output } from "./commands.js";

/**
 * atticus change impact <change> (ADR 0144, V1): what a change breaks across the estate, from its
 * target flows. For each entry or table they break: who calls or uses it today, the fields that
 * stop crossing, the gateway routes to update, each with its owner team. A link the join guessed
 * may break and is never counted as a sure break: the critic's constitution.change-links-known
 * asks its caller's owner to confirm it. Files only, the same view as the app's Architecture tab.
 */

export const CHANGE_IMPACT_WORDS = {
  usage: "Name the change: atticus change impact <change> [--json]",
  noChange: (id: string) => `There is no change ${id}: atticus change list shows them.`,
  noTargets: (id: string) =>
    `${id} has no target flows yet, so there is nothing to weigh: run atticus change architecture ${id} first.`,
  nothing: (id: string) =>
    `${id}'s target flows break nothing the map shows: no entry or table they change loses a field, a caller or its type.`,
  counts: (id: string, i: { breaks: number; mayBreak: number; routes: number }) =>
    `${id}: ${n(i.breaks, "caller")} ${i.breaks === 1 ? "breaks" : "break"}, ${n(i.mayBreak, "caller")} may break (link guessed), ${n(i.routes, "gateway route")} to update.`,
  item: (name: string, where: string, owner: string, why: string[]) =>
    `${name} (${where}), owned by ${owner}: ${why.join("; ")}.`,
  gone: (fields: string[]) => `  Stops crossing: ${fields.join(", ")}.`,
  required: (fields: string[]) => `  Callers must now send: ${fields.join(", ")}.`,
  breaks: (who: string, owner: string, where: string) =>
    `  Breaks: ${who}, owned by ${owner}${where ? `; ${where}` : ""}.`,
  mayBreak: (who: string, owner: string, how: string, where: string) =>
    `  May break (link guessed ${how}): ${who}, owned by ${owner}${where ? `; ${where}` : ""}. Not counted as a break until someone confirms the link.`,
  confirm: (rule: string, id: string) =>
    `  The critic's ${rule} asks the caller's owner to confirm each guessed link: atticus critic ${id}.`,
  nobody: "  The map shows nobody calling or using it.",
  route: (id: string, what: string, owner: string, callers: string[]) =>
    `  Gateway route to update: ${id}${what}, owned by ${owner}; ${callers.join(", ")} ${callers.length === 1 ? "calls" : "call"} through it.`,
  teams: "Teams to involve:",
  team: (owner: string, repos: string[]) => `  ${owner}: ${repos.join(", ")}`,
  problem: (p: string) => `Note: ${p}`,
};

const GUESS_WORDS: Record<string, string> = {
  "joined-by-path": "by path",
  "joined-by-label": "by a host's first label",
};

function n(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`;
}

/** An owner in a few words: "team-stock (Stock team)", or "no team (why)". */
export function ownerText(o: QuestionOwner): string {
  if ("none" in o) return `no team (${o.none})`;
  return o.name ? `${o.team} (${o.name})` : o.team;
}

/** The change's impact as the API gives it; undefined when there is no such change. */
export async function changeImpactOf(
  root: string,
  change: string,
): Promise<Api.ChangeImpactT | undefined> {
  const t = await targetFlowsOf(root, change);
  if (!t) return undefined;
  const problems = [...t.problems];
  const owners = new Map<string, string>();
  try {
    for (const r of await loadRepos(root)) owners.set(r.id, r.owner);
  } catch (e) {
    problems.push(`the repo manifests: ${(e as Error).message.split("\n")[0]}`);
  }
  const read = await readTeams(root);
  const teams: Team[] = read.teams;
  if (read.problem) problems.push(read.problem);
  const impact = changeImpact(change, t.deltas, await loadEstate(root, t.records), {
    owners,
    teams,
  });
  return { ...impact, flows: t.deltas.length, problems };
}

/** The impact in words, one line each. */
export function impactLines(i: Api.ChangeImpactT): string[] {
  const W = CHANGE_IMPACT_WORDS;
  if (!i.flows) return [W.noTargets(i.change), ...i.problems.map(W.problem)];
  if (!i.items.length) return [W.nothing(i.change), ...i.problems.map(W.problem)];
  const out = [W.counts(i.change, i)];
  for (const it of i.items) {
    out.push(
      W.item(
        it.name,
        it.kind === "table" ? `a table ${it.flow} writes` : it.flow,
        ownerText(it.owner),
        it.why,
      ),
    );
    if (it.fields.gone.length) out.push(W.gone(it.fields.gone));
    if (it.fields.required.length) out.push(W.required(it.fields.required));
    if (!it.callers.length) out.push(W.nobody);
    for (const c of it.callers) {
      const where = [
        ...c.at.map((a) => `at ${a}`),
        ...c.flows.map((f) => `its flow ${f}`),
        ...c.routes.map((r) => `through ${r}`),
      ].join(", ");
      out.push(
        c.verdict === "breaks"
          ? W.breaks(c.component, ownerText(c.owner), where)
          : W.mayBreak(c.component, ownerText(c.owner), GUESS_WORDS[c.guessed ?? ""] ?? "", where),
      );
    }
    if (it.callers.some((c) => c.verdict === "may-break")) out.push(W.confirm(i.rule, i.change));
    for (const r of it.routes) {
      const what = [r.proxy, r.basepath, r.repo ? `in ${r.repo}` : undefined]
        .filter(Boolean)
        .join(", ");
      out.push(W.route(r.id, what ? ` (${what})` : "", ownerText(r.owner), r.callers));
    }
  }
  out.push(W.teams, ...i.owners.map((o) => W.team(ownerText(o.owner), o.repos)));
  out.push(...i.problems.map(W.problem));
  return out;
}

export async function changeImpactCli(
  root: string,
  change: string | undefined,
  o: { json: boolean },
  io: Output,
): Promise<number> {
  if (!change) {
    io.err(CHANGE_IMPACT_WORDS.usage);
    return 2;
  }
  const i = await changeImpactOf(root, change);
  if (!i) {
    io.err(CHANGE_IMPACT_WORDS.noChange(change));
    return 1;
  }
  if (o.json) io.out(JSON.stringify(i, null, 2));
  else for (const l of impactLines(i)) io.out(l);
  return 0;
}
