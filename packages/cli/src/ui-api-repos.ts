import { Api } from "@maycombhq/core";
import { badRequest, conflict, notFound, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";

/**
 * The Repos screen (ADR 0123), through the local API: each repo's branches, what a branch scanned
 * beside the baseline changes against it, and setting a repo's branches in its manifest. Scanning
 * a branch is the scan job with `ref` (POST /api/scan).
 */
export function uiRepoRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  return (
    r
      .add("GET", "/api/repos/branches", async () => {
        const { repoBranches } = await import("./repo-branches.js");
        return { status: 200, body: Api.RepoBranchesList.parse(await repoBranches(root)) };
      })
      .add("GET", "/api/repos/compare", async ({ query }) => {
        const branch = query.get("branch")?.trim() ?? "";
        if (!branch) throw badRequest("Say which branch: ?branch=<name>.");
        const { compareBranch } = await import("./repo-branches.js");
        const c = await compareBranch(root, branch);
        if (!c) throw notFound(`${branch} hasn't been scanned beside the baseline yet.`);
        return { status: 200, body: Api.BranchCompare.parse(c) };
      })
      .add("PUT", "/api/repos/{repoId}/branches", async ({ params, body }) => {
        const b = Api.EditRepoBranchesRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Send defaultBranch and branches as branch names.");
        const { editRepoBranches, RepoEditError } = await import("./repo-branches.js");
        try {
          const file = await editRepoBranches(root, params.repoId!, b.data);
          ctx.events.publish({ type: "file.changed", path: file });
          return {
            status: 200,
            body: {
              file,
              note: `${file} changed: commit it in a pull request. Run atticus workspace sync if the default branch changed.`,
            },
          };
        } catch (e) {
          if (e instanceof RepoEditError)
            throw e.code === "not-found"
              ? notFound(e.message)
              : e.code === "conflict"
                ? conflict(e.message)
                : badRequest(e.message);
          throw e;
        }
      })
      // Seventh UX walk: a repo's build command, set on a person's click and proposed for review.
      .add("PUT", "/api/repos/{repoId}/build", async ({ params, body }) => {
        const b = Api.EditRepoBuildRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest('Send the build command as build ("" clears it), up to 500 characters.');
        const { editRepoBuild, RepoEditError } = await import("./repo-branches.js");
        try {
          const r = await editRepoBuild(root, params.repoId!, b.data);
          ctx.events.publish({ type: "file.changed", path: r.file });
          return {
            status: 200,
            body: {
              file: r.file,
              ...(r.build ? { build: r.build } : {}),
              note: r.build
                ? `${r.file} changed: propose it for review. A task in ${params.repoId} is now built and tested with it before its PR is raised; run the task again.`
                : `${r.file} changed: propose it for review. ${params.repoId} has no build command now, so its tasks aren't built or tested.`,
            },
          };
        } catch (e) {
          if (e instanceof RepoEditError)
            throw e.code === "not-found"
              ? notFound(e.message)
              : e.code === "conflict"
                ? conflict(e.message)
                : badRequest(e.message);
          throw e;
        }
      })
      // Seventh UX walk: who looks after the org pack, as atticus orgpack owner sets it.
      .add("PUT", "/api/orgpack/owner", async ({ body }) => {
        const b = Api.SetOrgPackOwnerRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Send the owner as one handle: { owner }.");
        const { setOrgPackOwner, OwnerEditError } = await import("./orgpack-owner.js");
        try {
          const r = await setOrgPackOwner(root, b.data.owner, b.data.was);
          ctx.events.publish({ type: "file.changed", path: r.file });
          return {
            status: 200,
            body: {
              file: r.file,
              owner: r.owner,
              note: `${r.owner} now looks after the org pack. ${r.file} changed: propose it for review; its owner approves changes to the org pack.`,
            },
          };
        } catch (e) {
          if (e instanceof OwnerEditError)
            throw e.code === "not-found"
              ? notFound(e.message)
              : e.code === "conflict"
                ? conflict(e.message)
                : badRequest(e.message);
          throw e;
        }
      })
      .add("PUT", "/api/repos/{repoId}/description", async ({ params, body }) => {
        const b = Api.EditRepoDescriptionRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest(
            "Send what the repo is as text, or accept: true to confirm the draft, or reject: true to drop it.",
          );
        const { editRepoDescription, RepoEditError } = await import("./repo-branches.js");
        try {
          const r = await editRepoDescription(root, params.repoId!, b.data);
          ctx.events.publish({ type: "file.changed", path: r.file });
          return {
            status: 200,
            body: {
              file: r.file,
              ...(r.description ? { description: r.description } : {}),
              note: r.description
                ? `${r.file} changed: commit it in a pull request. Every reading prompt, question and view of ${params.repoId} now says what it is.`
                : `${r.file} changed: commit it in a pull request. Nothing says what ${params.repoId} is now.`,
            },
          };
        } catch (e) {
          if (e instanceof RepoEditError)
            throw e.code === "not-found"
              ? notFound(e.message)
              : e.code === "conflict"
                ? conflict(e.message)
                : badRequest(e.message);
          throw e;
        }
      })
  );
}
