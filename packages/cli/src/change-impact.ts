import {
  normalizePath,
  readTeams,
  type Api,
  type CatalogRecord,
  type QuestionOwner,
  type Team,
} from "@maycombhq/core";
import { openIndex, receiversOfAll } from "@maycombhq/index";
import { changeImpact, loadEstate, MAX_CHAIN_DEPTH } from "@maycombhq/planner";
import { loadRepos } from "@maycombhq/workspace";
import { targetFlowsOf } from "./change-map.js";
import { callOf, componentOfRepo, quickViewOf } from "./change-quick.js";
import type { Output } from "./commands.js";
import { mapSides } from "./map-lacks.js";

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
  upstream: (u: { breaks: number; mayBreak: number }) =>
    `Up the chain (who calls the callers): ${u.breaks} more ${u.breaks === 1 ? "breaks" : "break"}, ${u.mayBreak} may break (resting on a guessed link).`,
  hopBreaks: (depth: number, via: string, who: string, owner: string, where: string) =>
    `${"  ".repeat(depth)}Breaks via ${via}: ${who}, owned by ${owner}${where ? `; ${where}` : ""}.`,
  hopMayBreak: (
    depth: number,
    via: string,
    who: string,
    owner: string,
    rests: string,
    where: string,
  ) =>
    `${"  ".repeat(depth)}May break via ${via} (${rests}): ${who}, owned by ${owner}${where ? `; ${where}` : ""}. Not counted as a break.`,
  restsOwn: (how: string) => `its own link guessed ${how}`,
  restsOn: (who: string, how: string) => `rests on ${who}'s link, guessed ${how}`,
  capped: (depth: number) =>
    `  The walk up the chain stops at ${depth} hops; more callers are above the last ones listed.`,
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
  // ADR 0206: a quick change, from its design.md's In the code.
  quick: (id: string) =>
    `${id}: a quick change says what its code will have, not which fields change, so Atticus can't tell what breaks; here is who each part it names reaches. Each owner confirms.`,
  quickNoTable: (id: string) =>
    `${id}'s impact is read from design.md's ## In the code, which it doesn't have yet: the spec writer writes it (/define-change ${id}).`,
  quickOperationsOnly: (id: string, n: number, kinds: string[]) =>
    `${id}'s design.md has ## In the code, but its ${n === 1 ? "row is an operation" : `${n} rows are operations`} (${kinds.join(", ")}), which name no call, entry, topic, table or deployment the map can follow, so the map can't say who ${n === 1 ? "it reaches" : "they reach"}. Each row is checked against the code: atticus change conform ${id}.`,
  operationRows: (n: number, kinds: string[]) =>
    `${n} more ${n === 1 ? "row is an operation" : "rows are operations"} (${kinds.join(", ")}): conform checks ${n === 1 ? "it" : "them"} against the code.`,
  calledBy: (who: string) => `  Called by ${who}: each must still reach it where it is deployed.`,
  nobodyCalls: "  Nothing in the map calls it.",
  reach: (name: string, has: string, line: number) => `${name} (design.md:${line}, ${has}):`,
  receivedBy: (who: string) => `  Received by ${who}.`,
  newCaller: (target: string, owner: string) => `  A new caller of ${target}, owned by ${owner}.`,
  nobodyReceives: "  Nothing in the map receives it.",
  further: (n: number) => `  Further: ${n} more record${n === 1 ? "" : "s"} through a receiver.`,
  notInMap: "  Not in the map yet: planned, or nobody has read it.",
};

/** ADR 0206: what a quick change's row names that the map has, and who receives it. */
type Reach = NonNullable<Api.ChangeImpactT["reaches"]>[number];

async function quickReaches(
  root: string,
  change: string,
  records: CatalogRecord[],
  problems: string[],
  operations: { line: number; has: string }[] = [],
): Promise<Reach[] | undefined> {
  const q = await quickViewOf(root, change);
  if (!q) return undefined;
  if (q.from !== "design") return [];
  const sides = await mapSides(root);
  const ix = await openIndex(root, { embedOnOpen: 0 });
  try {
    for (const p of ix.problems) problems.push(`${p.file}: ${p.message} (left out of the index)`);
    const rec = (id: string) =>
      records.find((r) => r.id === id) as
        (Record<string, unknown> & { id: string; kind: string }) | undefined;
    const ownerOf = (id: string) => {
      const r = rec(id);
      return (
        sides.owner({
          kind: r?.kind ?? "Component",
          id,
          ...(typeof r?.system === "string" ? { system: r.system } : {}),
        }) ??
        (typeof r?.repo === "string" ? sides.owner({ kind: "Component", id: r.repo }) : undefined)
      );
    };
    const out: Reach[] = [];
    for (const row of q.rows) {
      const comp = componentOfRepo(records, row.repo);
      let ids: string[] = [];
      if (row.has === "publishes" || row.has === "listens")
        ids = records
          .filter(
            (r) =>
              r.id === row.what ||
              (r.kind === "Endpoint" && (r as { pathOrTopic?: string }).pathOrTopic === row.what),
          )
          .map((r) => r.id);
      else if (row.has === "serves") {
        const [method, path] = row.what.split(/\s+/);
        ids = records
          .filter((r) => {
            const x = r as unknown as Record<string, unknown>;
            return (
              r.kind === "Endpoint" &&
              x.component === comp &&
              String(x.method ?? "").toUpperCase() === (method ?? "").toUpperCase() &&
              normalizePath(String(x.normalizedPath ?? x.pathOrTopic ?? "")) ===
                normalizePath(path ?? "")
            );
          })
          .map((r) => r.id);
      } else if (row.has === "table" || row.has === "column") {
        const table =
          row.has === "column" ? row.what.slice(0, row.what.lastIndexOf(".")) : row.what;
        ids = records
          .filter(
            (r) =>
              r.kind === "Table" && (r.id === table || (r as { name?: string }).name === table),
          )
          .map((r) => r.id);
      } else if (row.has === "calls") {
        const target = componentOfRepo(records, callOf(row.what).target);
        const owner = ownerOf(target);
        out.push({
          line: row.line,
          has: row.has,
          name: row.what,
          ids: rec(target) ? [target] : [],
          ...(owner ? { owner } : {}),
          receivers: [],
          further: 0,
        });
        continue;
      } else if (row.has === "deployment") {
        // The persona check of beta.30: what a deployment moves is called by these, from the map.
        const callers = [
          ...new Set(
            records
              .filter(
                (r) =>
                  r.kind === "Interface" &&
                  (r as { to?: string }).to === comp &&
                  (r as { from?: string }).from !== comp,
              )
              .map((r) => String((r as { from?: string }).from ?? ""))
              .filter(Boolean),
          ),
        ].sort();
        out.push({
          line: row.line,
          has: row.has,
          name: comp,
          ids: rec(comp) ? [comp] : [],
          receivers: callers.map((id) => {
            const owner = ownerOf(id);
            return { id, kind: rec(id)?.kind ?? "Component", ...(owner ? { owner } : {}) };
          }),
          further: 0,
        });
        continue;
      } else {
        operations.push({ line: row.line, has: row.has });
        continue;
      }
      const walk = ids.length ? receiversOfAll(ix, ids, 4, { owner: sides.owner }) : undefined;
      out.push({
        line: row.line,
        has: row.has,
        name: row.what,
        ids,
        receivers: (walk?.receivers ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          ...(a.owner ? { owner: a.owner } : {}),
        })),
        further: walk?.further.length ?? 0,
      });
    }
    return out;
  } finally {
    ix.close();
  }
}

const GUESS_WORDS: Record<string, string> = {
  "joined-by-path": "by path",
  "joined-by-label": "by a host's first label",
  "joined-by-platform-setting": "by a platform-wide setting",
  "joined-by-folder-name": "by a setting's folder name",
  "joined-despite-conflict": "despite an open host conflict",
  "joined-by-service-name": "by a Service's short name",
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
  // ADR 0206: a change with no target flow, read from its design.md's In the code.
  const operations: { line: number; has: string }[] = [];
  const reaches = t.deltas.length
    ? undefined
    : await quickReaches(root, change, t.records, problems, operations);
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
  return {
    ...impact,
    flows: t.deltas.length,
    ...(reaches ? { from: "design" as const, reaches } : {}),
    ...(reaches && operations.length ? { operations } : {}),
    problems,
  };
}

/** The impact in words, one line each. */
export function impactLines(i: Api.ChangeImpactT): string[] {
  const W = CHANGE_IMPACT_WORDS;
  if (!i.flows && i.from === "design") {
    const ops = i.operations ?? [];
    const kinds = [...new Set(ops.map((o) => o.has))];
    if (!i.reaches?.length)
      return [
        ops.length ? W.quickOperationsOnly(i.change, ops.length, kinds) : W.quickNoTable(i.change),
        ...i.problems.map(W.problem),
      ];
    const out = [W.quick(i.change)];
    for (const r of i.reaches) {
      out.push(W.reach(r.name, r.has, r.line));
      if (r.has === "deployment") {
        out.push(
          !r.ids.length
            ? W.notInMap
            : r.receivers.length
              ? W.calledBy(
                  r.receivers.map((x) => (x.owner ? `${x.id} (${x.owner})` : x.id)).join(", "),
                )
              : W.nobodyCalls,
        );
        continue;
      }
      if (r.has === "calls") {
        out.push(
          r.ids.length ? W.newCaller(r.ids[0]!, r.owner ?? "no team on record") : W.notInMap,
        );
        continue;
      }
      if (!r.ids.length) out.push(W.notInMap);
      else if (!r.receivers.length) out.push(W.nobodyReceives);
      else
        out.push(
          W.receivedBy(
            r.receivers.map((x) => (x.owner ? `${x.id} (${x.owner})` : x.id)).join(", "),
          ),
        );
      if (r.further) out.push(W.further(r.further));
    }
    if (ops.length) out.push(W.operationRows(ops.length, kinds));
    return [...out, ...i.problems.map(W.problem)];
  }
  if (!i.flows) return [W.noTargets(i.change), ...i.problems.map(W.problem)];
  if (!i.items.length) return [W.nothing(i.change), ...i.problems.map(W.problem)];
  const out = [W.counts(i.change, i)];
  if (i.upstream && (i.upstream.breaks || i.upstream.mayBreak)) out.push(W.upstream(i.upstream));
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
    // ADR 0156: who calls the callers, indented by depth.
    for (const h of it.chain ?? []) {
      const via = `${h.via.join(", ")}${h.entries.length ? ` (${h.entries.join(", ")})` : ""}`;
      const where = [
        ...h.at.map((a) => `at ${a}`),
        ...h.flows.map((f) => `its flow ${f}`),
        ...h.routes.map((r) => `through ${r}`),
      ].join(", ");
      const how = GUESS_WORDS[h.guessed ?? ""] ?? "";
      out.push(
        h.verdict === "breaks"
          ? W.hopBreaks(h.depth, via, h.component, ownerText(h.owner), where)
          : W.hopMayBreak(
              h.depth,
              via,
              h.component,
              ownerText(h.owner),
              h.restsOn ? W.restsOn(h.restsOn, how) : W.restsOwn(how),
              where,
            ),
      );
    }
    if (it.capped) out.push(W.capped(MAX_CHAIN_DEPTH));
    if ([...it.callers, ...(it.chain ?? [])].some((c) => c.verdict === "may-break"))
      out.push(W.confirm(i.rule, i.change));
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
