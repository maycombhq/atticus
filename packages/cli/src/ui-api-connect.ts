import { Api, factIdPart, loadOrgPack, orgPackDirOf, type OrgPack } from "@maycombhq/core";
import { estateFacts, estateRepos } from "@maycombhq/scanner";
import { badRequest, notFound, type Router, type ServerContext } from "@maycombhq/server";
import { arrowOf, boxWords, knownEnd, parseBox } from "./connect-arrows.js";
import { lastBuildOf } from "./build-report.js";
import { candidatesOf, linksJob, type LinkSteps } from "./ui-api-links.js";

/**
 * ADR 0204 decisions 1 and 3, B.1 and B.2: GET /api/connect, what connecting box A to box B is,
 * the direction as asked (never turned round). The caller's calls are today's candidates
 * (`candidatesOf`, the reconnect fix's order and how each was decided); a declared arrow is the
 * profile's; what is missing is a need with the step that fixes it. Files only.
 */

/** A system box of the estate is its one repo; with several or none it is a need. */
function resolve(
  op: OrgPack,
  b: Api.LinkBoxT,
  end: "from" | "to",
): { box: Api.LinkBoxT; name: string; need?: Api.ConnectNeedT } {
  if (b.repo) {
    if (!estateRepos(op).some((r) => r.id === b.repo))
      throw notFound(`No repo of the manifest is ${b.repo}.`);
    return { box: b, name: b.repo };
  }
  const sys = op.profiles.flatMap((p) => p.profile?.systems ?? []).find((s) => s.id === b.system);
  const repos = estateRepos(op)
    .filter((r) => (r.system ?? factIdPart(r.id)) === b.system)
    .map((r) => r.id)
    .sort();
  const name = sys?.name ?? b.system!;
  if (repos.length === 1) return { box: { repo: repos[0]! }, name: repos[0]! };
  if (repos.length > 1)
    return { box: b, name, need: { need: "pick-repo", end, label: name, repos } };
  if (!sys) {
    if (!knownEnd(op, b)) return { box: b, name, need: { need: "add-system", end, label: name } };
  } else if (sys.boundary === "product")
    return { box: b, name, need: { need: "no-repo", end, label: name } };
  return { box: b, name };
}

export async function connectView(
  root: string,
  from0: Api.LinkBoxT,
  to0: Api.LinkBoxT,
  s?: LinkSteps,
): Promise<Api.ConnectViewT> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const a = resolve(op, from0, "from");
  const b = resolve(op, to0, "to");
  const [from, to] = [a.box, b.box];
  if (boxWords(from) === boxWords(to) && !!from.repo === !!to.repo)
    throw badRequest("Pick another box: a box can't call itself here.");
  const base = { from, to, fromName: a.name, toName: b.name, existing: 0 };
  const needs = [a.need, b.need].filter((x): x is Api.ConnectNeedT => !!x);
  const declared = arrowOf(root, op, from, to);
  if (declared) {
    const shown = (await lastBuildOf(root))?.declaredSuperseded?.find(
      (x) =>
        x.from === `${from.repo ? "repo" : "system"}:${boxWords(from)}` &&
        x.to === `${to.repo ? "repo" : "system"}:${boxWords(to)}`,
    );
    return {
      ...base,
      mechanism: "declared",
      needs,
      declared,
      ...(shown ? { superseded: { calls: shown.calls }, existing: shown.calls } : {}),
    };
  }
  if (needs.some((n) => n.need !== "read" && n.need !== "verify"))
    return { ...base, mechanism: "needs", needs };
  // An outside system calling a gateway: its routes can be declared too (ADR 0200's list).
  const routes =
    !!from.system && /^gateway(-|$)/.test(estateRepos(op).find((r) => r.id === to.repo)?.type ?? "")
      ? { routes: true }
      : {};
  // What B lacks, said with the step that reads it (3.1); declare stays beside it (3.2).
  const est = await estateFacts(root, op, "");
  const state = (repo: string): Api.ConnectNeedT["need"] | undefined =>
    est.repos.some((r) => r.repo === repo && r.facts.length)
      ? undefined
      : est.unverified.includes(repo)
        ? "verify"
        : "read";
  for (const [end, x] of [
    ["to", to],
    ["from", from],
  ] as const)
    if (x.repo && state(x.repo))
      needs.push({
        need: state(x.repo)!,
        end,
        label: x.repo,
        repos: [x.repo],
        command:
          state(x.repo) === "verify"
            ? `atticus verify ${x.repo}`
            : `atticus map --all --repos ${x.repo}`,
      });
  if (!from.repo || state(from.repo) || (to.system && !knownOutside(op, to.system)))
    return { ...base, mechanism: "declare", needs, ...routes };
  const { view } = await candidatesOf(root, from.repo, to, s);
  // B.1: any call of A's not inside A that doesn't go to B already could be B's.
  const here = view.calls.filter((c) => c.status === "here" || c.status === "paired");
  const could = view.calls.filter((c) => c.status !== "here" && c.status !== "paired" && !c.inside);
  const mechanism = could.length ? "calls" : here.length ? "connected" : "declare";
  return {
    ...base,
    existing: here.length,
    mechanism,
    needs,
    candidates: view,
    ...routes,
  };
}

/** An outside system of the profiles: Connect's candidates know only those by id. */
const knownOutside = (op: OrgPack, id: string) =>
  op.profiles.some((p) =>
    (p.profile?.systems ?? []).some((s) => s.id === id && s.boundary !== "product"),
  );

export function uiConnectRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/connect", async ({ query }) => {
    const from = parseBox(query.get("from"), "from");
    const to = parseBox(query.get("to"), "to");
    if (["1", "true"].includes(query.get("job") ?? ""))
      return linksJob(
        ctx,
        `Reading what connects ${boxWords(from)} to ${boxWords(to)}`,
        "The read",
        (s) => connectView(ctx.root, from, to, s),
      );
    return { status: 200, body: await connectView(ctx.root, from, to) };
  });
}
