import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Api, changedLines, changesDirOf, changesRelOf, lfOnly } from "@maycombhq/core";
import { changeFolder, changeStore } from "@maycombhq/changes";
import {
  applyStroke,
  drawnStrokes,
  loadEstate,
  planSketchWrite,
  readDeltas,
  sketchFingerprint,
  Stroke,
  TARGET_DIR,
  writeSketch,
  type FlowDelta,
} from "@maycombhq/planner";
import { badRequest, conflict, notFound, type Router, type ServerContext } from "@maycombhq/server";
import { changeMapBody, changeMapOf, targetFlowsOf } from "./change-map.js";
import { safeMessage, withFileLock } from "./file-lock.js";

/**
 * ADR 0179: a change drawn on the canvas. A stroke (a call, a topic, a table, a step removed or
 * sent elsewhere, one taken back) becomes steps in the change's target-flows/, the files the
 * architecture stage writes and the change diagram draws. Preview first; the write is of exactly
 * the files the preview showed (the changed flows' files, and design.md / data.md where Atticus
 * wrote them), and is refused when the target flows changed since the preview. The files are
 * locked while written: two strokes at once never lose one. Nothing here is a fact.
 */

const CHANGE = /^[a-z0-9][a-z0-9._-]{0,199}$/;

/** The strokes drawn here, for Undo. */
export const drawnOf = (deltas: readonly FlowDelta[]): Api.SketchResultT["drawn"] =>
  drawnStrokes(deltas);

export function uiSketchRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  const changeOf = (v: string) => {
    if (!CHANGE.test(v)) throw badRequest(`${v} isn't a change id.`);
    return v;
  };
  const commitOf = (change: string) =>
    `git add ${changesRelOf(root)}/${change} && git commit -m "${safeMessage(`${change}: drawn on the canvas`)}"`;
  return r
    .add("GET", "/api/changes/{changeId}/sketch", async ({ params }) => {
      const change = changeOf(params.changeId!);
      const m = await changeMapOf(root, change);
      if (!m) throw notFound(`There is no change ${change}.`);
      const dir = join(changesDirOf(root), change);
      const { deltas } = await readDeltas(dir);
      return {
        status: 200,
        body: {
          written: false,
          files: [],
          map: changeMapBody(change, m),
          drawn: drawnOf(deltas),
          commit: commitOf(change),
          fingerprint: await sketchFingerprint(dir),
        } satisfies Api.SketchResultT,
      };
    })
    .add("POST", "/api/changes/{changeId}/sketch", async ({ params, body }) => {
      const change = changeOf(params.changeId!);
      const b = Api.SketchStrokeRequest.safeParse(body ?? {});
      if (!b.success) throw badRequest("Say the stroke: { stroke: { kind, ... }, preview? }.");
      const s = Stroke.safeParse(b.data.stroke);
      if (!s.success)
        throw badRequest("The stroke isn't one Atticus draws.", {
          errors: s.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      const c = await changeStore(root)
        .read(change)
        .catch(() => undefined);
      if (!c) throw notFound(`There is no change ${change}.`);
      const dir = changeFolder(root, change);
      const t = await targetFlowsOf(root, change);
      if (!t) throw notFound(`There is no change ${change}.`);
      const estate = await loadEstate(root, t.records);
      const by = `${ctx.user ?? "a person"} on the canvas`;
      return withFileLock(join(dir, TARGET_DIR), async () => {
        const fingerprint = await sketchFingerprint(dir);
        const { deltas, problems } = await readDeltas(dir);
        const answer = (extra: Partial<Api.SketchResultT>): Api.SketchResultT => ({
          written: false,
          files: [],
          drawn: drawnOf(deltas),
          commit: commitOf(change),
          fingerprint,
          ...extra,
        });
        // A delta file that doesn't read would be lost by any write: nothing is drawn over it.
        if (problems.length)
          return {
            status: 200,
            body: answer({
              problem: `A target flow of ${change} doesn't read, so nothing is drawn until it is fixed: ${problems[0]}`,
            }),
          };
        // The stroke's id comes from the stroke and the files it lands on, so the write is the preview.
        const strokeId = createHash("sha256")
          .update(fingerprint)
          .update(JSON.stringify(s.data))
          .digest("hex")
          .slice(0, 8);
        const res = applyStroke(deltas, s.data, estate, by, strokeId);
        if (res.problem)
          return {
            status: 200,
            body: answer({ problem: res.problem, ...(res.pick ? { pick: res.pick } : {}) }),
          };
        const plan = await planSketchWrite(dir, res.deltas, res.changed, estate, by);
        const files = (
          await Promise.all(
            plan.map(async (f) => ({
              file: `${changesRelOf(root)}/${change}/${f.file}`,
              changes: changedLines(
                lfOnly(await readFile(join(dir, ...f.file.split("/")), "utf8").catch(() => "")),
                lfOnly(f.now ?? ""),
              ),
            })),
          )
        ).filter((f) => f.changes.length);
        if (b.data.preview)
          return { status: 200, body: answer({ files, drawn: drawnOf(res.deltas) }) };
        // The write is of what was previewed: files that changed meanwhile are left alone.
        if (b.data.expect !== undefined && b.data.expect !== fingerprint)
          throw conflict(
            `${change}'s target flows changed since the preview: look again, then draw the stroke again.`,
          );
        await writeSketch(dir, plan);
        for (const f of files) ctx.events.publish({ type: "file.changed", path: f.file });
        const m = await changeMapOf(root, change);
        return {
          status: 200,
          body: answer({
            written: true,
            files,
            ...(m ? { map: changeMapBody(change, m) } : {}),
            drawn: drawnOf(res.deltas),
            fingerprint: await sketchFingerprint(dir),
          }),
        };
      });
    });
}
