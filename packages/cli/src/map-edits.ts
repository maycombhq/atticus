import { existsSync } from "node:fs";
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
import { estateRepos, factsSlotPaths, readCatalog } from "@maycombhq/scanner";
import { HttpError } from "@maycombhq/server";
import { pairingsOf } from "./ui-api-links.js";

/**
 * Edit the map (beta.28): what POST /api/map/edits checks before it writes anything, and the
 * caller repos the changes touch. A delete names Interfaces the catalog has now; an add is what
 * POST /api/declared-links would write (a system of the profiles, a topic only for a system whose
 * repos the manifests don't list, nothing declared already), each tried as Declare's preview,
 * which writes nothing; an add from a repo's box is what POST /api/links/connect would write (each
 * call on record, each API of the other box's), and a redirect's starts in the repo whose calls
 * the arrow is; the same add (or the same call paired) twice in one list is refused the second
 * time.
 */
export async function checkMapEdits(
  root: string,
  edits: readonly Api.MapEditT[],
): Promise<{ problems: Api.MapEditProblemT[]; callers: string[]; waitsOn: string[] }> {
  const records = (await readCatalog(join(catalogDirOf(root), "generated"), { fresh: true }))
    .records;
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const op = await loadOrgPack(orgPackDirOf(root));
  const repos = estateRepos(op);
  const reposOf = (system: string) => repos.filter((r) => r.system === system).map((r) => r.id);
  const problems: Api.MapEditProblemT[] = [];
  const callers = new Set<string>();
  const staged = new Set<string>();
  // The repos a new link is joined through, not read from their facts yet (no facts snapshot):
  // the link is drawn once they are (a pairing's other repo; a declared call's gateway).
  const unread = (repo: string) => !existsSync(factsSlotPaths(root, repo).facts);
  const waits = new Set<string>();
  for (const [edit, e] of edits.entries()) {
    const said: string[] = [];
    const theirs = new Set<string>();
    if (e.kind !== "add" && !e.delete.interfaces.length)
      said.push(
        `The arrow ${e.delete.from} → ${e.delete.to} names no call to take away: it isn't one of calls, or not every call on it was read. Pick it again.`,
      );
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
        if (from?.kind === "Component" && from.repo) theirs.add(from.repo);
        else if (from?.kind === "System") for (const r of reposOf(from.id)) theirs.add(r);
      }
      for (const r of theirs) callers.add(r);
    }
    if ("pair" in e) {
      const p = e.pair;
      // A redirect's new link starts where the arrow's calls are made.
      if (e.kind === "redirect" && theirs.size && !theirs.has(p.from))
        said.push(
          `The arrow's calls are made in ${[...theirs].join(", ")}, not ${p.from}: the redirected link starts there.`,
        );
      for (const x of p.pairs) {
        const key = `pair\u0000${p.from}\u0000${x.call}`;
        if (staged.has(key)) said.push(`${p.from}'s call ${x.call} is paired twice: remove one.`);
        staged.add(key);
      }
      try {
        const made = await pairingsOf(root, p, { by: "preview", at: new Date(0).toISOString() });
        // A lined arrow's redirect pairs the calls the arrow is: each pair's call cites one of
        // the deleted Interfaces' caller lines (a lineless arrow's are the person's pick).
        if (e.kind === "redirect") {
          const lines = new Set(
            e.delete.interfaces.flatMap((id) => {
              const i = byId.get(id);
              return (i?.evidence ?? [])
                .filter((x) => x.side === "caller" && x.repo === p.from && x.path && x.line)
                .map((x) => `${x.path}:${x.line}`);
            }),
          );
          const others = lines.size
            ? made.corrections.filter((c) => !lines.has(`${c.target.file}:${c.target.line}`))
            : [];
          if (others.length)
            said.push(
              `${others.map((c) => `${c.fact} (${c.target.file}:${c.target.line})`).join(", ")} ${others.length === 1 ? "isn't a call" : "aren't calls"} of the arrow ${e.delete.from} → ${e.delete.to}: a redirect moves the arrow's own calls. Add a link for the others.`,
            );
        }
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        said.push(err.detail ?? err.title);
      }
      callers.add(p.from);
      if (p.to.repo && unread(p.to.repo)) waits.add(p.to.repo);
    } else if (e.kind !== "delete") {
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
      if (a.kind === "call")
        for (const r of repos)
          if (/gateway|proxy|apigee/i.test(r.type ?? "") && unread(r.id)) waits.add(r.id);
    }
    if (said.length) problems.push({ edit, message: said.join(" ") });
  }
  return {
    problems,
    callers: [...callers].sort(cmpText),
    waitsOn: [...waits].filter((r) => !callers.has(r)).sort(cmpText),
  };
}
