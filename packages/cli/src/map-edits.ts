import { join } from "node:path";
import {
  catalogDirOf,
  cmpText,
  declareLink,
  DeclareError,
  loadOrgPack,
  orgPackDirOf,
  type Api,
} from "@maycombhq/core";
import { estateRepos, readCatalog } from "@maycombhq/scanner";

/**
 * Edit the map (beta.28): what POST /api/map/edits checks before it writes anything, and the
 * caller repos the changes touch. A delete names Interfaces the catalog has now; an add is what
 * POST /api/declared-links would write (a system of the profiles, a topic only for a system whose
 * repos the manifests don't list, nothing declared already), each tried as Declare's preview,
 * which writes nothing; the same add twice in one list is refused the second time.
 */
export async function checkMapEdits(
  root: string,
  edits: readonly Api.MapEditT[],
): Promise<{ problems: Api.MapEditProblemT[]; callers: string[] }> {
  const records = (await readCatalog(join(catalogDirOf(root), "generated"), { fresh: true }))
    .records;
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const op = await loadOrgPack(orgPackDirOf(root));
  const repos = estateRepos(op);
  const reposOf = (system: string) => repos.filter((r) => r.system === system).map((r) => r.id);
  const problems: Api.MapEditProblemT[] = [];
  const callers = new Set<string>();
  const staged = new Set<string>();
  for (const [edit, e] of edits.entries()) {
    const said: string[] = [];
    if (e.kind !== "add") {
      const missing = e.delete.interfaces.filter((id) => byId.get(id)?.kind !== "Interface");
      if (missing.length)
        said.push(
          `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} ${missing.length === 1 ? "isn't an Interface" : "aren't Interfaces"} of the catalog now: the link may be gone already.`,
        );
      // The caller's repo: the component's, or the repos of the system the call comes from.
      for (const id of e.delete.interfaces) {
        const i = byId.get(id);
        if (i?.kind !== "Interface") continue;
        const from = byId.get(i.from);
        if (from?.kind === "Component" && from.repo) callers.add(from.repo);
        else if (from?.kind === "System") for (const r of reposOf(from.id)) callers.add(r);
      }
    }
    if (e.kind !== "delete") {
      const a = e.add;
      const value = a.kind === "call" ? a.route.trim() : a.topic.trim();
      const key = `${a.system}\u0000${a.kind}\u0000${value}`;
      if (a.kind === "topic" && reposOf(a.system).length)
        said.push(
          `${a.system}'s repos are in the manifest: their code says what it publishes and listens on. Read them (atticus map) rather than declaring it.`,
        );
      else if (staged.has(key))
        said.push(`${value} for ${a.system} is staged twice: remove one of them.`);
      else
        try {
          await declareLink(
            root,
            a.kind === "call"
              ? { kind: "call", system: a.system, route: a.route }
              : { kind: "topic", system: a.system, topic: a.topic, side: a.side },
            { by: "preview", at: new Date(0).toISOString(), preview: true },
          );
        } catch (err) {
          if (!(err instanceof DeclareError)) throw err;
          said.push(err.message);
        }
      staged.add(key);
      for (const r of reposOf(a.system)) callers.add(r);
    }
    if (said.length) problems.push({ edit, message: said.join(" ") });
  }
  return { problems, callers: [...callers].sort(cmpText) };
}
