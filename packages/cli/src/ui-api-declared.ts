import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addProfileSystem,
  Api,
  cmpText,
  declarableGateways,
  declarableRoutes,
  declaredArrows,
  declaredOf,
  declareArrow,
  declareLink,
  DeclareError,
  factIdPart,
  factsDirOf,
  factsRelOf,
  FileChangedError,
  joinConventions,
  loadOrgPack,
  parseFacts,
  orgPackDirOf,
  orgPackRelOf,
  parseCorrections,
  retireArrow,
  undeclareLink,
  type Declared,
  type FactCorrection,
  type OrgPack,
} from "@maycombhq/core";
import { estateFacts, estateRepos, joinReposOf, targetPicker } from "@maycombhq/scanner";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { safeMessage } from "./file-lock.js";
import {
  arrowOf,
  arrowPlatform,
  arrowView,
  boxOfEnd,
  boxWords,
  connectedWords,
  endOf,
  knownEnd,
  realCalls,
} from "./connect-arrows.js";
import { readRepos } from "./target-answer.js";
import { looksLikeGatewayType } from "./ui-api-links.js";

/**
 * G3 (ADR 0174): add a box, declare a link the code can't show, and every box's corrections with
 * Undo. Declarations go to the profile that has the system, with who and when as the line's
 * comment, for review; a new vendor or team system goes to the profile the same way. Nothing here
 * writes a fact: a declared topic lands where the estate's code publishes or listens on it with
 * no counterpart (ADR 0162), drawn dashed and marked declared.
 */

const REPO = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * What a repo's facts say of a pairing: the box its call's line names, when it is another than
 * the pairing's (`decidedOf`), and whether the last read has the call at all (by its id, else
 * by its cited line). Nothing where the facts don't read.
 */
async function pairingsRead(root: string, repo: string) {
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(() => "");
  const parsed = text.trim() ? parseFacts(text) : undefined;
  if (!parsed?.ok) return undefined;
  const op = await loadOrgPack(orgPackDirOf(root));
  const { decidedOf } = await import("./link-how.js");
  const d = await decidedOf(root, repo, op, parsed.facts);
  const calls = parsed.facts.filter((f) => f.kind === "call");
  return (c: FactCorrection) => {
    const id =
      calls.find((f) => f.id === c.fact)?.id ??
      calls.find((f) => f.cite.file === c.target.file && f.cite.line === c.target.line)?.id;
    const names = id ? d.codeNames(id) : undefined;
    return {
      gone: !id,
      names: names && names.box !== (c.link?.repo ?? c.link?.system) ? names : undefined,
    };
  };
}

const says = (c: FactCorrection): string => {
  const what = `${c.target.kind} ${c.target.value} (${c.target.file}:${c.target.line})`;
  if (c.action === "wrong") return `${what} is wrong: ${c.reason ?? ""}`.trim();
  if (c.action === "link")
    return `${what} goes to ${[c.link?.method, c.link?.path].filter(Boolean).join(" ")} on ${c.link?.repo ?? c.link?.system}${c.ai ? ` (detected by AI, run ${c.ai.run})` : ""}`;
  // ADR 0181: a person said the call reaches none of these.
  if (c.action === "unlink") return `${what} reaches none of these`;
  const set = Object.entries(c.set ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `${what}: ${[set, c.line ? `line ${c.line}` : ""].filter(Boolean).join(", ")}`;
};

/**
 * Beta.28.1 (field hunt G4): the system a box is, from the id a request names it by: a system of
 * the profiles as it is; a repo of the manifest as the canvas draws its box (the manifest's
 * `system`, else the slug of the repo's id: `forge.instruments.svc` is `forge-instruments-svc`).
 * Any other id as it is (the declaration then says no system is that).
 */
export function boxSystemOf(op: OrgPack, id: string): string {
  if (op.profiles.some((p) => (p.profile?.systems ?? []).some((s) => s.id === id))) return id;
  const repo = estateRepos(op).find((x) => x.id === id);
  return repo ? (repo.system ?? factIdPart(repo.id)) : id;
}

/**
 * Beta.28.1 (field report 4): the System a declaration from this box needs added first, when no
 * profile has it: the box the canvas draws for a repo the manifest lists with no System of the
 * profiles (its id the manifest's `system`, else the repo's), in that repo's platform's profile,
 * owned by the repo's team. Undefined for a system a profile has, or one no repo is drawn in.
 */
export function systemToCreate(
  op: OrgPack,
  system: string,
): { platform: string; owner?: string } | undefined {
  if (op.profiles.some((p) => (p.profile?.systems ?? []).some((s) => s.id === system)))
    return undefined;
  // The review (N4): the same pick whatever order the profiles load in. A platform with a profile
  // to add it to first, then by platform and repo id; its owner only when the platform's repos
  // drawn in it agree on one.
  const hasProfile = new Set(op.profiles.filter((p) => !!p.profile).map((p) => p.platform));
  const drawn = estateRepos(op)
    .filter((x) => (x.system ?? factIdPart(x.id)) === system)
    .sort(
      (a, b) =>
        Number(hasProfile.has(b.platform)) - Number(hasProfile.has(a.platform)) ||
        cmpText(a.platform, b.platform) ||
        cmpText(a.id, b.id),
    );
  const r = drawn[0];
  if (!r) return undefined;
  const owners = new Set(drawn.filter((x) => x.platform === r.platform).map((x) => x.owner));
  const owner = owners.size === 1 ? [...owners][0] : undefined;
  return { platform: r.platform, ...(owner ? { owner } : {}) };
}

/**
 * The re-review of beta.28.1: whether a person's pairing (a `link` correction to it) or an
 * answer (a target question's) names the system, by its id or its name's slug: a System the
 * canvas added is then kept when its last declaration goes.
 */
export async function systemInUse(root: string, op: OrgPack, system: string): Promise<boolean> {
  const est = await estateFacts(root, op, "");
  const is = (v: string | undefined) => !!v && (v === system || factIdPart(v) === system);
  return (
    Object.values(est.pairs).some((m) => Object.values(m).some((x) => !x.none && is(x.system))) ||
    Object.values(est.targets).some((m) => Object.values(m).some(is))
  );
}

export function uiDeclaredRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  const fail = (e: unknown): never => {
    // Edited meanwhile (another request, the CLI, an editor): nothing was written.
    if (e instanceof FileChangedError) throw conflict(e.message);
    if (e instanceof DeclareError) {
      if (e.code === "not-found") throw notFound(e.message);
      if (e.code === "exists") throw conflict(e.message);
      throw new HttpError(422, "Atticus can't write that", e.message);
    }
    throw e;
  };
  return r
    .add("GET", "/api/boxes/addable", async () => {
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      const picks = targetPicker(op, await readRepos(ctx.root));
      return {
        status: 200,
        body: {
          repos: picks
            .filter((p) => p.kind === "repo")
            .map((p) => ({ id: p.id, name: p.name, read: p.read === true })),
          systems: picks
            .filter((p) => p.kind === "system")
            .map((p) => ({
              id: p.id,
              name: p.name,
              ...(p.boundary ? { boundary: p.boundary } : {}),
            })),
          teams: picks.filter((p) => p.kind === "team").map((p) => ({ id: p.id, name: p.name })),
        } satisfies Api.AddableViewT,
      };
    })
    .add("POST", "/api/boxes", async ({ body }) => {
      const b = Api.AddSystemRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say the system's id, name and whether it is a vendor or another team's.",
          {
            errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        );
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      if (op.profiles.some((p) => (p.profile?.systems ?? []).some((s) => s.id === b.data.id)))
        throw conflict(`A system of the profiles is ${b.data.id} already: it is on the picture.`);
      const anyRepo = estateRepos(op)[0];
      if (!anyRepo)
        throw conflict("No repo is in a manifest yet, so there is no profile to add it to.");
      const sys = {
        id: b.data.id,
        name: b.data.name,
        boundary: b.data.boundary,
        ...(b.data.owner ? { owner: b.data.owner } : {}),
      };
      if (b.data.preview) {
        // The lines the write itself would make, nothing hand-built.
        const res = await addProfileSystem(ctx.root, anyRepo.id, sys, { preview: true }).catch(
          (e: unknown) => {
            throw new HttpError(
              422,
              "Atticus can't write that",
              e instanceof Error ? e.message : String(e),
            );
          },
        );
        return {
          status: 200,
          body: {
            written: false,
            files: [{ file: res.profile, changes: res.changes ?? [] }],
            verify: "atticus verify --all --write",
            commit: "",
          } satisfies Api.FileChangeResultT,
        };
      }
      try {
        const res = await addProfileSystem(ctx.root, anyRepo.id, sys);
        ctx.events.publish({ type: "file.changed", path: res.profile });
        return {
          status: 200,
          body: {
            written: true,
            files: [{ file: res.profile, changes: res.changes ?? [] }],
            verify: "atticus verify --all --write",
            commit: `git add ${res.profile}\ngit commit -m "${safeMessage(`profile: ${b.data.id} added from the canvas`)}"`,
          } satisfies Api.FileChangeResultT,
        };
      } catch (e) {
        if (e instanceof FileChangedError) throw conflict(e.message);
        throw new HttpError(
          422,
          "Atticus can't write that",
          e instanceof Error ? e.message : String(e),
        );
      }
    })
    .add("POST", "/api/declared-links", async ({ body }) => {
      // ADR 0204: a declared arrow between two boxes, into the profile's `links`.
      if ((body as { kind?: unknown } | null)?.kind === "link") {
        const a = Api.DeclareArrowRequest.safeParse(body);
        if (!a.success)
          throw badRequest("Say both boxes and why: { kind: link, from, to, why }.", {
            errors: a.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        try {
          const res = await writeArrow(ctx.root, a.data, {
            by: ctx.user,
            at: now().toISOString(),
            ...(a.data.preview ? { preview: true } : {}),
          });
          if (res.written) ctx.events.publish({ type: "file.changed", path: res.rel });
          return { status: 200, body: arrowChange(res, a.data) };
        } catch (e) {
          return fail(e);
        }
      }
      const b = Api.DeclareLinkRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say the system and the topic with its side (publishes or listens), or the route it calls.",
          { errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        );
      // ADR 0200: one route (`route`) or several (`routes`), never neither and never both.
      if (b.data.kind === "call" && (b.data.route === undefined) === (b.data.routes === undefined))
        throw badRequest("Say the route it calls (route), or the routes (routes): one of the two.");
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      // G4: a repo's id names the system its box is drawn as.
      b.data.system = boxSystemOf(op, b.data.system);
      // A system whose repos are read says what it publishes in its code: no word is needed.
      const own = estateRepos(op).some((x) => x.system === b.data.system);
      if (own && b.data.kind === "topic")
        throw conflict(
          `${b.data.system}'s repos are in the manifest: their code says what it publishes and listens on. Read them (atticus map) rather than declaring it.`,
        );
      try {
        const { preview, ...asked } = b.data;
        const d: Declared =
          asked.kind === "topic"
            ? asked
            : asked.routes
              ? { kind: "call", system: asked.system, routes: asked.routes }
              : { kind: "call", system: asked.system, route: asked.route! };
        const create = systemToCreate(op, d.system);
        const res = await declareLink(ctx.root, d, {
          by: ctx.user,
          at: now().toISOString(),
          ...(preview ? { preview } : {}),
          ...(create ? { create } : {}),
        });
        if (res.written) ctx.events.publish({ type: "file.changed", path: res.rel });
        const many =
          d.kind === "call" && "routes" in d ? new Set(d.routes.map((x) => x.trim())) : undefined;
        const what =
          d.kind === "topic"
            ? `${d.side} ${d.topic}`
            : many
              ? many.size === 1
                ? `calls ${[...many][0]}`
                : `calls ${many.size} gateway routes`
              : `calls ${"route" in d ? d.route : ""}`;
        return {
          status: 200,
          body: {
            written: res.written,
            files: [{ file: res.rel, changes: res.changes }],
            ...(res.created ? { created: { system: res.created, file: res.rel } } : {}),
            verify: "atticus verify --all --write",
            commit: `git add ${res.rel}\ngit commit -m "${safeMessage(`profile: ${d.system} ${what}, declared on the canvas`)}"`,
          } satisfies Api.FileChangeResultT,
        };
      } catch (e) {
        return fail(e);
      }
    })
    .add("GET", "/api/declared-links/routes", async ({ query }) => {
      // ADR 0200: what a system can be declared to call, listed to pick from. A declared call
      // lands only on a gateway route, so the routes come from the join's own rule for one (a
      // gateway repo's entries, any repo's under a proxy bundle folder), never a looser guess.
      const asked = query.get("system");
      const repo = query.get("repo");
      if (!asked) throw badRequest("Say system=<id>, and repo=<repo> for its routes.");
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      const system = boxSystemOf(op, asked);
      const known = repo === null ? undefined : estateRepos(op).find((r) => r.id === repo);
      if (repo !== null && !known) throw notFound(`No repo of the manifest is ${repo}.`);
      // A system only the code names is in no profile, and no repo's box either: its
      // declaration would be refused, so the panel is told before anything is ticked.
      const inProfile =
        op.profiles.some((p) => (p.profile?.systems ?? []).some((s) => s.id === system)) ||
        !!systemToCreate(op, system);
      const estate = await estateFacts(ctx.root, op, "");
      const input = {
        repos: joinReposOf(op, estate.repos),
        bundleFolders: joinConventions(op).bundleFolders,
      };
      const declared = (await declaredOf(ctx.root, system)).list
        .filter((x) => x.kind === "call")
        .map((x) => x.value);
      const t = repo ? declarableRoutes({ ...input, repo, declared }) : undefined;
      return {
        status: 200,
        body: {
          system,
          inProfile,
          gateways: declarableGateways(input),
          ...(repo && t
            ? {
                target: {
                  repo,
                  gateway: t.gateway,
                  routes: t.routes,
                  entries: t.entries,
                  ...(known?.type ? { type: known.type } : {}),
                  ...(known
                    ? {
                        manifest: `${orgPackRelOf(ctx.root)}/profiles/${known.platform}/repos.manifest.yaml`,
                      }
                    : {}),
                  // Connect would call its entries routes; the join doesn't. Said, with the fix.
                  ...(!t.gateway && looksLikeGatewayType(known?.type)
                    ? { looksLikeGateway: true }
                    : {}),
                  ...(estate.repos.some((r) => r.repo === repo)
                    ? {}
                    : {
                        notRead: estate.unverified.includes(repo)
                          ? { why: "unverified" as const, command: `atticus verify ${repo}` }
                          : {
                              why: "not-read" as const,
                              command: `atticus map --all --repos ${repo}`,
                            },
                      }),
                },
              }
            : {}),
        } satisfies Api.DeclarableRoutesViewT,
      };
    })
    .add("POST", "/api/declared-links/undo", async ({ body }) => {
      // ADR 0204: Remove it, Retire the declared arrow: exactly that item of `links`.
      if ((body as { kind?: unknown } | null)?.kind === "link") {
        const a = Api.UndeclareArrowRequest.safeParse(body);
        if (!a.success) throw badRequest("Say which arrow: { kind: link, from, to }.");
        try {
          const op = await loadOrgPack(orgPackDirOf(ctx.root));
          const declared = arrowOf(ctx.root, op, a.data.from, a.data.to);
          if (!declared)
            throw notFound(
              `No arrow ${boxWords(a.data.from)} → ${boxWords(a.data.to)} is declared (retired already?).`,
            );
          const res = await retireArrow(
            ctx.root,
            { from: endOf(a.data.from), to: endOf(a.data.to) },
            {
              platform: declared.file.split("/").slice(-2)[0]!,
              ...(a.data.preview ? { preview: true } : {}),
            },
          );
          if (res.written) ctx.events.publish({ type: "file.changed", path: res.rel });
          return {
            status: 200,
            body: {
              written: res.written,
              files: [{ file: res.rel, changes: res.changes }],
              verify: "atticus catalog build",
              commit: `git add ${res.rel}\ngit commit -m "${safeMessage(`profile: the declared arrow ${boxWords(a.data.from)} → ${boxWords(a.data.to)} retired`)}"`,
            } satisfies Api.FileChangeResultT,
          };
        } catch (e) {
          return fail(e);
        }
      }
      const b = Api.UndeclareLinkRequest.safeParse(body ?? {});
      if (!b.success) throw badRequest("Say which declaration: { kind, system, value }.");
      try {
        const op = await loadOrgPack(orgPackDirOf(ctx.root));
        b.data.system = boxSystemOf(op, b.data.system);
        const res = await undeclareLink(ctx.root, b.data, {
          inUse: await systemInUse(ctx.root, op, b.data.system),
        });
        ctx.events.publish({ type: "file.changed", path: res.rel });
        return {
          status: 200,
          body: {
            written: true,
            files: [{ file: res.rel, changes: res.changes }],
            verify: "atticus verify --all --write",
            commit: `git add ${res.rel}\ngit commit -m "${safeMessage(`profile: ${b.data.system}: a declaration undone`)}"`,
            ...(res.removed ? { removed: { system: res.removed, file: res.rel } } : {}),
          } satisfies Api.FileChangeResultT,
        };
      } catch (e) {
        return fail(e);
      }
    })
    .add("GET", "/api/boxes/corrections", async ({ query }) => {
      const repo = query.get("repo");
      const system = query.get("system");
      if (!repo === !system) throw badRequest("Say repo=<repo> or system=<id>.");
      const items: Api.BoxCorrectionsT["items"] = [];
      if (repo) {
        if (!REPO.test(repo)) throw badRequest(`${JSON.stringify(repo)} isn't a repo name.`);
        const rel = `${factsRelOf(ctx.root)}/${repo}.corrections.jsonl`;
        const text = await readFile(
          join(factsDirOf(ctx.root), `${repo}.corrections.jsonl`),
          "utf8",
        ).catch(() => "");
        // Beta.30 (the review): a pairing that goes over what the call's line names says so, with
        // the box it was moved from and the person's reason (hard rule 6: the fact stays as read).
        const read = text.includes('"link"') ? await pairingsRead(ctx.root, repo) : undefined;
        // Each line on its own, so Undo removes exactly the line a correction came from.
        for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
          const c = parseCorrections(line).corrections[0];
          if (!c) continue;
          const of = c.action === "link" ? read?.(c) : undefined;
          const names = c.ai ? undefined : of?.names;
          const said = names
            ? `${says(c)}, moved by ${c.by} from ${names.box} over what its line names (${names.text})${c.reason ? `: "${c.reason}"` : ""}`
            : says(c);
          items.push({
            kind: c.action,
            // The re-review: a pairing whose call the last read doesn't have is kept, and said.
            says: of?.gone ? `${said} (its call isn't in the last read)` : said,
            ...(of?.gone ? { stale: true } : {}),
            ...(names ? { over: { ...names, ...(c.reason ? { reason: c.reason } : {}) } } : {}),
            by: c.by,
            at: c.at,
            ...(c.ai ? { ai: { runtime: c.ai.runtime, run: c.ai.run } } : {}),
            ...(c.batch ? { batch: c.batch } : {}),
            file: rel,
            undo: { repo, line },
          });
        }
      } else {
        const d = await declaredOf(ctx.root, system!);
        // Only what was declared from the canvas (who and when on its line) has Undo here.
        for (const x of d.list.filter((y) => y.by))
          items.push({
            kind: x.kind,
            says:
              x.kind === "topic" ? `${x.side ? `${x.side} ` : ""}${x.value}` : `calls ${x.value}`,
            ...(x.by ? { by: x.by } : {}),
            ...(x.at ? { at: x.at } : {}),
            file: d.rel!,
            undo: { kind: x.kind, system: x.system, value: x.value },
          });
      }
      // ADR 0204: the declared arrows at either end of the box, each with its Remove.
      const box: Api.LinkBoxT = repo ? { repo } : { system: system! };
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      for (const d of declaredArrows(op)) {
        const [f, t] = [boxOfEnd(d.from), boxOfEnd(d.to)];
        if (![f, t].some((x) => x.repo === box.repo && x.system === box.system)) continue;
        items.push({
          kind: "arrow",
          says: `${boxWords(f)} calls ${boxWords(t)}, declared: "${d.why}"${d.planned ? " (not built yet)" : ""}`,
          by: d.by,
          at: d.at,
          file: arrowView(ctx.root, d).file,
          undo: { kind: "link", from: f, to: t },
        });
      }
      return { status: 200, body: { items } satisfies Api.BoxCorrectionsT };
    });
}

/**
 * ADR 0204 1.4 and 1.7: write (or preview) a declared arrow, checked first: both ends known, not
 * the same box, and no real call the same way already (409 with the `connected` words). Edit the
 * map's Apply writes through this too.
 */
export async function writeArrow(
  root: string,
  a: { from: Api.LinkBoxT; to: Api.LinkBoxT; why: string; planned?: boolean | undefined },
  o: { by: string; at: string; preview?: boolean },
) {
  const op = await loadOrgPack(orgPackDirOf(root));
  for (const b of [a.from, a.to])
    if (!knownEnd(op, b))
      throw notFound(
        `No ${b.repo ? "repo of the manifests" : "system of the profiles"} is ${boxWords(b)}.`,
      );
  if (boxWords(a.from) === boxWords(a.to) && !!a.from.repo === !!a.to.repo)
    throw badRequest("An arrow's two ends differ: pick another box.");
  const n = await realCalls(root, op, a.from, a.to);
  if (n) throw conflict(connectedWords(a.from, a.to, n));
  return declareArrow(
    root,
    { from: endOf(a.from), to: endOf(a.to), why: a.why, ...(a.planned ? { planned: true } : {}) },
    { ...o, platform: arrowPlatform(op, a.from, a.to) },
  );
}

const arrowChange = (
  res: Awaited<ReturnType<typeof writeArrow>>,
  a: { from: Api.LinkBoxT; to: Api.LinkBoxT },
): Api.FileChangeResultT => ({
  written: res.written,
  files: [{ file: res.rel, changes: res.changes }],
  verify: "atticus catalog build",
  commit: `git add ${res.rel}\ngit commit -m "${safeMessage(`profile: ${boxWords(a.from)} calls ${boxWords(a.to)}, declared on the canvas`)}"`,
});
