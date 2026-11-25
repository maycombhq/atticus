import { join } from "node:path";
import {
  Api,
  factIdPart,
  isAdopted,
  loadOrgPack,
  orgPackDirOf,
  type OrgPack,
} from "@maycombhq/core";
import { estateFacts, estateRepos } from "@maycombhq/scanner";
import { badRequest, conflict, notFound, type Router, type ServerContext } from "@maycombhq/server";
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
  /** A declared arrow's own words: who, when, why; the code now showing it; the last find. */
  const declaredPart = async () => {
    const shown = (await lastBuildOf(root))?.declaredSuperseded?.find(
      (x) =>
        x.from === `${from.repo ? "repo" : "system"}:${boxWords(from)}` &&
        x.to === `${to.repo ? "repo" : "system"}:${boxWords(to)}`,
    );
    // A.6: the last find of this arrow.
    const { readFindReport, findAgainOf, findFilesOf } = await import("./connect-find.js");
    const find = from.repo
      ? (
          await readFindReport(join(root, ...findFilesOf(root, from.repo, to).report.split("/")))
        ).find((e) => e.to.repo === to.repo && e.to.system === to.system)
      : undefined;
    return {
      declared: declared!,
      ...(shown ? { superseded: { calls: shown.calls }, existing: shown.calls } : {}),
      ...(find ? { find } : {}),
      ...(find?.outcome === "not-found"
        ? { findAgain: await findAgainOf(root, from.repo!, find) }
        : {}),
    };
  };
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
  const d = declared ? await declaredPart() : undefined;
  if (!from.repo || state(from.repo) || (to.system && !knownOutside(op, to.system))) {
    // A's read is there and B is an outside system the profiles don't name: say that (the review).
    const unknown =
      !!from.repo && !state(from.repo) && !!to.system
        ? { whyNone: { why: "outside-unknown" as const, calls: 0 } }
        : {};
    return d
      ? { ...base, mechanism: "declared", needs, ...d, ...routes }
      : { ...base, mechanism: "declare", needs, ...routes, ...unknown };
  }
  const { view } = await candidatesOf(root, from.repo, to, s);
  // B.1: any call of A's not inside A that doesn't go to B already could be B's. A declared
  // arrow never hides them (the review): `calls` wins, the declared arrow said beside it.
  const here = view.calls.filter((c) => c.status === "here" || c.status === "paired");
  const could = view.calls.filter((c) => c.status !== "here" && c.status !== "paired" && !c.inside);
  const mechanism =
    could.length && !d?.superseded
      ? "calls"
      : d
        ? "declared"
        : here.length
          ? "connected"
          : "declare";
  return {
    ...base,
    existing: here.length,
    mechanism,
    needs,
    candidates: view,
    ...routes,
    ...(d ?? {}),
    ...(mechanism === "declare"
      ? {
          whyNone: whyNoneOf(
            view,
            /^gateway(-|$)/.test(estateRepos(op).find((r) => r.id === from.repo)?.type ?? ""),
          ),
        }
      : {}),
  };
}

/**
 * ADR 0210: why Connect has no call of A's to offer, from the candidates it read. In "declare"
 * no call is here, paired or open, so what's left is a read with no call, calls that all stay
 * inside A's component, or call facts the candidates didn't list at all.
 */
export function whyNoneOf(
  view: Api.LinkCandidatesViewT,
  gateway: boolean,
): NonNullable<Api.ConnectViewT["whyNone"]> {
  if (view.noCalls)
    return {
      why: "no-calls",
      calls: 0,
      command: view.noCalls.command,
      ...(view.noCalls.why === "unverified" ? { unverified: true } : {}),
      ...(gateway ? { gateway: true } : {}),
    };
  const n = view.calls.length;
  return n && view.calls.every((c) => !!c.inside)
    ? { why: "all-inside", calls: n }
    : { why: "none-open", calls: n };
}

/** An outside system of the profiles: Connect's candidates know only those by id. */
const knownOutside = (op: OrgPack, id: string) =>
  op.profiles.some((p) =>
    (p.profile?.systems ?? []).some((s) => s.id === id && s.boundary !== "product"),
  );

export function uiConnectRoutes(r: Router, ctx: ServerContext): Router {
  return (
    r
      .add("GET", "/api/connect", async ({ query }) => {
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
      })
      // ADR 0204 A.9: Find it in the code, a job of parts; its answer is FindResult.
      .add("POST", "/api/connect/find", async ({ body }) => {
        const b = Api.ConnectFindRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest("Say the caller and the callee: { from, to: { repo } | { system } }.");
        const { runFind } = await import("./connect-find.js");
        const { from, to, mode, read } = b.data;
        const go = (s?: LinkSteps) =>
          runFind(ctx.root, {
            from,
            to,
            ...(mode ? { mode } : {}),
            ...(read ? { read } : {}),
            ...(s ? { step: (w: string) => s.step(w) } : {}),
          });
        if (b.data.job)
          return linksJob(
            ctx,
            `Finding ${from} → ${boxWords(to)} in the code`,
            "The find",
            async (s) => ({
              ...(await go(s)),
            }),
          );
        return { status: 200, body: await go() };
      })
      // ADR 0204 A.8: Make this a reading rule, from the call a find confirmed: a draft only.
      .add("POST", "/api/reading-rules/from-find", async ({ body }) => {
        const b = Api.RuleFromFindRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Say the repo and the callee: { repo, to }.");
        const { readFindReport, findFilesOf } = await import("./connect-find.js");
        const { repo, to } = b.data;
        const e = (
          await readFindReport(join(ctx.root, ...findFilesOf(ctx.root, repo, to).report.split("/")))
        ).find((x) => x.to.repo === to.repo && x.to.system === to.system);
        if (!e?.shape || (e.outcome !== "found" && e.outcome !== "found-loose"))
          throw notFound(`No find of ${repo} → ${boxWords(to)} confirmed a call to learn from.`);
        const op = await loadOrgPack(orgPackDirOf(ctx.root));
        const type = estateRepos(op).find((x) => x.id === repo)?.type;
        if (!type) throw notFound(`No repo of the manifest is ${repo}.`);
        const declared = arrowOf(ctx.root, op, { repo }, to);
        const [file, line] = [
          e.shape.at.slice(0, e.shape.at.lastIndexOf(":")),
          Number(e.shape.at.split(":").pop()),
        ];
        const { ruleFromPairing } = await import("./reading-rules.js");
        const { rulesAddCommand } = await import("./rules-commands.js");
        const rule = ruleFromPairing({
          type,
          to: boxWords(to),
          file,
          line,
          value: e.shape.value,
          path: "/",
          by: ctx.user,
          drafter: ctx.user,
        });
        const said: string[] = [];
        const code = await rulesAddCommand(
          ctx.root,
          { type },
          {
            key: rule.key,
            rule: rule.rule,
            files: (rule.files ?? []).join(","),
            ...(rule.example ? { example: rule.example } : {}),
            draft: true,
            by: `from a declared arrow the code confirmed, ${declared?.by ?? ctx.user}, ${e.at.slice(0, 10)}`,
          },
          { out: (l) => said.push(l), err: (l) => said.push(l) },
        );
        if (code !== 0) throw conflict(said.join(" "));
        const rel = `${isAdopted(ctx.root) ? ".atticus/org-pack" : "org-pack"}/reading-rules/types/${type}.yaml`;
        ctx.events.publish({ type: "file.changed", path: rel });
        return {
          status: 200,
          body: {
            file: rel,
            key: rule.key,
            rule: rule.rule,
            activate: `atticus rules activate ${rule.key} --type ${type}`,
          } satisfies Api.RuleFromPairingResultT,
        };
      })
  );
}
