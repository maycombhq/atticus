import { Api } from "@maycombhq/core";
import { badRequest, notFound, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";

/**
 * The Repos screen (ADR 0123), through the local API: each repo's branches, what a branch scanned
 * beside the baseline changes against it, and setting a repo's branches in its manifest. Scanning
 * a branch is the scan job with `ref` (POST /api/scan).
 */
export function uiRepoRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  return r
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
          throw e.code === "not-found" ? notFound(e.message) : badRequest(e.message);
        throw e;
      }
    });
}
