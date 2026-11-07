import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addProfileSystem,
  Api,
  declaredOf,
  declareLink,
  DeclareError,
  factsDirOf,
  factsRelOf,
  FileChangedError,
  loadOrgPack,
  orgPackDirOf,
  parseCorrections,
  undeclareLink,
  type FactCorrection,
} from "@maycombhq/core";
import { estateRepos, targetPicker } from "@maycombhq/scanner";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { safeMessage } from "./file-lock.js";
import { readRepos } from "./target-answer.js";

/**
 * G3 (ADR 0174): add a box, declare a link the code can't show, and every box's corrections with
 * Undo. Declarations go to the profile that has the system, with who and when as the line's
 * comment, for review; a new vendor or team system goes to the profile the same way. Nothing here
 * writes a fact: a declared topic lands where the estate's code publishes or listens on it with
 * no counterpart (ADR 0162), drawn dashed and marked declared.
 */

const REPO = /^[A-Za-z0-9._-]{1,200}$/;

const says = (c: FactCorrection): string => {
  const what = `${c.target.kind} ${c.target.value} (${c.target.file}:${c.target.line})`;
  if (c.action === "wrong") return `${what} is wrong: ${c.reason ?? ""}`.trim();
  if (c.action === "link")
    return `${what} goes to ${[c.link?.method, c.link?.path].filter(Boolean).join(" ")} on ${c.link?.repo ?? c.link?.system}`;
  const set = Object.entries(c.set ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `${what}: ${[set, c.line ? `line ${c.line}` : ""].filter(Boolean).join(", ")}`;
};

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
            commit: `git add ${res.profile} && git commit -m "${safeMessage(`profile: ${b.data.id} added from the canvas`)}"`,
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
      const b = Api.DeclareLinkRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say the system and the topic with its side (publishes or listens), or the route it calls.",
          { errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        );
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      // A system whose repos are read says what it publishes in its code: no word is needed.
      const own = estateRepos(op).some((x) => x.system === b.data.system);
      if (own && b.data.kind === "topic")
        throw conflict(
          `${b.data.system}'s repos are in the manifest: their code says what it publishes and listens on. Read them (atticus map) rather than declaring it.`,
        );
      try {
        const { preview, ...d } = b.data;
        const res = await declareLink(ctx.root, d, {
          by: ctx.user,
          at: now().toISOString(),
          ...(preview ? { preview } : {}),
        });
        if (res.written) ctx.events.publish({ type: "file.changed", path: res.rel });
        const what = d.kind === "topic" ? `${d.side} ${d.topic}` : `calls ${d.route}`;
        return {
          status: 200,
          body: {
            written: res.written,
            files: [{ file: res.rel, changes: res.changes }],
            verify: "atticus verify --all --write",
            commit: `git add ${res.rel} && git commit -m "${safeMessage(`profile: ${d.system} ${what}, declared on the canvas`)}"`,
          } satisfies Api.FileChangeResultT,
        };
      } catch (e) {
        return fail(e);
      }
    })
    .add("POST", "/api/declared-links/undo", async ({ body }) => {
      const b = Api.UndeclareLinkRequest.safeParse(body ?? {});
      if (!b.success) throw badRequest("Say which declaration: { kind, system, value }.");
      try {
        const res = await undeclareLink(ctx.root, b.data);
        ctx.events.publish({ type: "file.changed", path: res.rel });
        return {
          status: 200,
          body: {
            written: true,
            files: [{ file: res.rel, changes: res.changes }],
            verify: "atticus verify --all --write",
            commit: `git add ${res.rel} && git commit -m "${safeMessage(`profile: ${b.data.system}: a declaration undone`)}"`,
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
        // Each line on its own, so Undo removes exactly the line a correction came from.
        for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
          const c = parseCorrections(line).corrections[0];
          if (!c) continue;
          items.push({
            kind: c.action,
            says: says(c),
            by: c.by,
            at: c.at,
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
      return { status: 200, body: { items } satisfies Api.BoxCorrectionsT };
    });
}
