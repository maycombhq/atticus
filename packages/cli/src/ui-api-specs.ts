import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  changesDirOf,
  changesRelOf,
  readEstateJoins,
  readRepoSpec,
  RecordId,
  specRelOf,
  specRepos,
  type Api,
  type EstateJoins,
  type FlowRecord,
} from "@maycombhq/core";
import { mergeDelta, readDeltas, TARGET_DIR } from "@maycombhq/planner";
import { badRequest, notFound, type Router, type ServerContext } from "@maycombhq/server";
import { estimateOf } from "./change-estimate.js";
import { changeMapBody, changeMapOf } from "./change-map.js";

/**
 * The specs API (ADR 0092, C4): what the Flows screen draws. It reads files only: each repo's
 * spec folder (ADR 0079) and specs/estate.yaml, the estate pass's joins (ADR 0085). It runs
 * nothing and writes nothing.
 */

const idOf = (v: string, what: string) => {
  if (!RecordId.safeParse(v).success)
    throw badRequest(`${v} isn't a ${what} id. Ids are lowercase: a-z, 0-9, '.', '_' and '-'.`);
  return v;
};

const confirmed = (f: FlowRecord) => f.steps.filter((s) => s.confirmedBy).length;

export function uiSpecRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;

  /** The repo's spec, or a 404 when the repo has no spec folder. */
  const specOf = async (repo: string) => {
    if (!(await specRepos(root)).includes(repo))
      throw notFound(`${repo} has no spec. Draft one with atticus spec draft ${repo}.`);
    return readRepoSpec(root, repo);
  };

  /** Each flow's name, for the repos named, read once. */
  const namesIn = async (repos: string[]) => {
    const names = new Map<string, string>();
    const have = new Set(await specRepos(root));
    for (const repo of [...new Set(repos)].filter((x) => have.has(x)))
      for (const f of (await readRepoSpec(root, repo)).flows) names.set(f.id, f.name);
    return names;
  };

  const linksOf = (joins: EstateJoins | undefined, flow: string) => ({
    out: (joins?.joins ?? []).filter((j) => j.from.flow === flow),
    in: (joins?.joins ?? []).filter((j) => j.to.flow === flow),
    unmatched: (joins?.unmatched ?? []).filter((u) => u.from.flow === flow),
  });

  r.add("GET", "/api/specs", async () => {
    const repos: Api.SpecListT["repos"] = [];
    for (const repo of await specRepos(root))
      repos.push({ repo, flows: (await readRepoSpec(root, repo)).flows.length });
    return { status: 200, body: { repos } satisfies Api.SpecListT };
  });

  r.add("GET", "/api/specs/{repo}", async ({ params }) => {
    const repo = idOf(params.repo!, "repo");
    const spec = await specOf(repo);
    const joins = await readEstateJoins(root);
    const body: Api.SpecViewT = {
      repo,
      path: specRelOf(root, repo),
      ...(spec.header?.commit ? { commit: spec.header.commit } : {}),
      ...(spec.header?.template ? { template: spec.header.template } : {}),
      flows: spec.flows.map((f) => {
        const l = linksOf(joins, f.id);
        return {
          id: f.id,
          name: f.name,
          component: f.component,
          trigger: { kind: f.trigger.kind, what: f.trigger.what },
          steps: f.steps.length,
          confirmed: confirmed(f),
          errors: f.errors.length,
          calls: l.out.length,
          calledBy: l.in.length,
        };
      }),
      problems: spec.problems,
    };
    return { status: 200, body: body };
  });

  r.add("GET", "/api/specs/{repo}/flows/{flowId}", async ({ params }) => {
    const repo = idOf(params.repo!, "repo");
    const id = idOf(params.flowId!, "flow");
    const flow = (await specOf(repo)).flows.find((f) => f.id === id);
    if (!flow) throw notFound(`${repo}'s spec has no flow ${id}.`);
    const joins = await readEstateJoins(root);
    const l = linksOf(joins, id);
    const names = await namesIn([...l.out.map((j) => j.to.repo), ...l.in.map((j) => j.from.repo)]);
    const named = (flowId: string) => {
      const n = names.get(flowId);
      return n ? { name: n } : {};
    };
    const body: Api.FlowViewT = {
      repo,
      file: `${specRelOf(root, repo)}/${id}.yaml`,
      flow,
      joined: joins !== undefined,
      calls: l.out.map((j) => ({
        step: j.from.step,
        repo: j.to.repo,
        flow: j.to.flow,
        ...named(j.to.flow),
        how: j.how,
      })),
      calledBy: l.in.map((j) => ({
        step: j.from.step,
        repo: j.from.repo,
        flow: j.from.flow,
        ...named(j.from.flow),
        how: j.how,
      })),
      unmatched: l.unmatched.map((u) => ({
        step: u.from.step,
        entry: u.entry,
        reason: u.reason,
        message: u.message,
      })),
    };
    return { status: 200, body };
  });

  // ADR 0095: a change's target flows beside today's flows in the specs.
  const deltasOf = async (change: string) => {
    const dir = join(changesDirOf(root), change);
    if (!(await stat(join(dir, "change.yaml")).catch(() => undefined)))
      throw notFound(`There is no change ${change}.`);
    return readDeltas(dir);
  };
  const todayOf = async (repo: string, flow: string) =>
    (await specRepos(root)).includes(repo)
      ? (await readRepoSpec(root, repo)).flows.find((f) => f.id === flow)
      : undefined;

  r.add("GET", "/api/changes/{changeId}/target-flows", async ({ params }) => {
    const change = idOf(params.changeId!, "change");
    const { deltas, problems } = await deltasOf(change);
    const flows: Api.TargetFlowListT["flows"] = [];
    for (const d of deltas) {
      const m = mergeDelta(d, await todayOf(d.repo, d.flow));
      flows.push({
        flow: d.flow,
        repo: d.repo,
        change: d.change,
        name: m.name,
        why: d.why,
        ...m.counts,
      });
    }
    return { status: 200, body: { change, flows, problems } satisfies Api.TargetFlowListT };
  });

  // ADR 0109: the change's estimate, counted from the same target flows.
  r.add("GET", "/api/changes/{changeId}/estimate", async ({ params }) => {
    const change = idOf(params.changeId!, "change");
    const e = await estimateOf(root, change);
    if (!e) throw notFound(`There is no change ${change}.`);
    return { status: 200, body: e };
  });

  // ADR 0108: the change's picture, drawn from the same target flows.
  r.add("GET", "/api/changes/{changeId}/map", async ({ params }) => {
    const change = idOf(params.changeId!, "change");
    const m = await changeMapOf(root, change);
    if (!m) throw notFound(`There is no change ${change}.`);
    return { status: 200, body: changeMapBody(change, m) };
  });

  r.add("GET", "/api/changes/{changeId}/target-flows/{flowId}", async ({ params }) => {
    const change = idOf(params.changeId!, "change");
    const flow = idOf(params.flowId!, "flow");
    const d = (await deltasOf(change)).deltas.find((x) => x.flow === flow);
    if (!d) throw notFound(`Change ${change} has no target flow ${flow}.`);
    const { flow: _f, repo: _r, change: delta, ...m } = mergeDelta(d, await todayOf(d.repo, flow));
    const body: Api.TargetFlowViewT = {
      change,
      file: `${changesRelOf(root)}/${change}/${TARGET_DIR}/${flow}.yaml`,
      flow,
      repo: d.repo,
      delta,
      ...m,
    };
    return { status: 200, body };
  });

  return r;
}
