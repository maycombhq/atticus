import {
  addRolesTeam,
  Api,
  loadOrgPack,
  FileChangedError,
  ManifestEditError,
  manifestFiles,
  orgPackDirOf,
  setManifestField,
} from "@maycombhq/core";
import { estateRepos } from "@maycombhq/scanner";
import { safeMessage } from "./file-lock.js";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * G2 (ADR 0174): a repo's owner and system, set from its box on the canvas. The manifest that
 * lists the repo is edited in place (comments and order kept), after the person's yes; a team no
 * team file names is added to roles.yaml for review. A preview gives the lines it would change.
 */

const REPO = /^[A-Za-z0-9._-]{1,200}$/;
const TEAM = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function uiOwnerRoutes(r: Router, ctx: ServerContext): Router {
  const options = async (repo: string) => {
    if (!REPO.test(repo)) throw badRequest(`${JSON.stringify(repo)} isn't a repo name.`);
    const op = await loadOrgPack(orgPackDirOf(ctx.root));
    const entry = estateRepos(op).find((x) => x.id === repo);
    if (!entry) throw notFound(`No repo of the manifest is ${repo}.`);
    const teams = (op.roles?.teams ?? []).map((t) => ({ id: t.id, name: t.name ?? t.id }));
    const seen = new Set<string>();
    const systems = op.profiles
      .flatMap((p) => p.profile?.systems ?? [])
      .filter((s) => !seen.has(s.id) && !!seen.add(s.id))
      .map((s) => ({ id: s.id, name: s.name || s.id }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return { entry, teams, systems };
  };
  return r
    .add("GET", "/api/repos/{repo}/owner", async ({ params }) => {
      const repo = params.repo!;
      const o = await options(repo);
      const file = (await manifestFiles(ctx.root)).find((f) => f.platform === o.entry.platform);
      return {
        status: 200,
        body: {
          repo,
          owner: o.entry.owner,
          ...(o.entry.system ? { system: o.entry.system } : {}),
          file: file?.rel ?? "org-pack/profiles",
          teams: o.teams,
          systems: o.systems,
        } satisfies Api.RepoOwnerViewT,
      };
    })
    .add("PUT", "/api/repos/{repo}/owner", async ({ params, body }) => {
      const repo = params.repo!;
      const b = Api.SetRepoOwnerRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say the owner, the system, or a team to add: { owner, system, addTeam }.",
          {
            errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        );
      const o = await options(repo);
      const { addTeam, preview, system } = b.data;
      let owner = b.data.owner;
      if (addTeam) {
        if (!TEAM.test(addTeam.id))
          throw badRequest(
            `${addTeam.id} isn't a team id: lower case, digits and dashes, e.g. team-ledger.`,
          );
        if (o.teams.some((t) => t.id === addTeam.id))
          throw badRequest(`${addTeam.id} is a team already: pick it as the owner.`);
        owner = addTeam.id;
      } else if (
        owner &&
        !o.teams.some((t) => t.id === owner) &&
        (o.teams.length || !TEAM.test(owner))
      )
        throw badRequest(`No team in roles.yaml is ${owner}: pick one, or add it as a new team.`);
      if (system && !o.systems.some((s) => s.id === system))
        throw badRequest(`No system of the profiles is ${system}.`);
      const files: Api.SetRepoOwnerResultT["files"] = [];
      try {
        if (addTeam) {
          const t = await addRolesTeam(ctx.root, addTeam, { preview: true });
          files.push({ file: t.rel, changes: t.changes });
        }
        if (owner) {
          const m = await setManifestField(ctx.root, repo, "owner", owner, { preview: true });
          files.push({ file: m.file.rel, changes: m.changes });
        }
        if (system) {
          const m = await setManifestField(ctx.root, repo, "system", system, { preview: true });
          const f = files.find((x) => x.file === m.file.rel);
          // Both fields in one manifest: one diff for both, worked out on the write.
          if (f) f.changes.push(...m.changes);
          else files.push({ file: m.file.rel, changes: m.changes });
        }
        if (!preview) {
          if (addTeam) await addRolesTeam(ctx.root, addTeam);
          if (owner) await setManifestField(ctx.root, repo, "owner", owner);
          if (system) await setManifestField(ctx.root, repo, "system", system);
          for (const f of files) ctx.events.publish({ type: "file.changed", path: f.file });
        }
      } catch (e) {
        if (e instanceof FileChangedError) throw conflict(e.message);
        if (e instanceof ManifestEditError)
          throw e.code === "not-found"
            ? notFound(e.message)
            : new HttpError(422, "Atticus can't write that", e.message);
        throw e;
      }
      return {
        status: 200,
        body: {
          written: !preview,
          files,
          verify: "atticus verify --all --write",
          commit: `git add ${files.map((f) => f.file).join(" ")} && git commit -m "${safeMessage(`${repo}: ${[owner ? `owner ${owner}` : "", system ? `system ${system}` : ""].filter(Boolean).join(", ")}`)}"`,
        } satisfies Api.SetRepoOwnerResultT,
      };
    });
}
