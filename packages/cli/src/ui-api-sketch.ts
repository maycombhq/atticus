import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Api, changedLines, changesDirOf, changesRelOf, eolOf, lfOnly } from "@maycombhq/core";
import { changeFolder, changeStore } from "@maycombhq/changes";
import {
  applyStroke,
  FLOW_DELTA_SCHEMA_VERSION,
  flowBase,
  FlowDelta as FlowDeltaSchema,
  loadEstate,
  readDeltas,
  Stroke,
  TARGET_DIR,
  writeTargetFlows,
  type FlowDelta,
} from "@maycombhq/planner";
import { stringify } from "yaml";
import { badRequest, conflict, notFound, type Router, type ServerContext } from "@maycombhq/server";
import { changeMapBody, changeMapOf, targetFlowsOf } from "./change-map.js";
import { safeMessage, withFileLock } from "./file-lock.js";

/**
 * ADR 0179: a change drawn on the canvas. A stroke (a call, a topic, a table, a step removed or
 * sent elsewhere, one taken back) becomes a flow delta in the change's target-flows/, the files
 * the architecture stage writes and the change diagram draws. Preview first; nothing is written
 * without the person's yes. The files are locked while written: two strokes at once never lose
 * one. Nothing here is a fact.
 */

const CHANGE = /^[a-z0-9][a-z0-9._-]{0,199}$/;

/** The strokes drawn here, for Undo: a step in a delta whose `why` says it was drawn. */
export function drawnOf(deltas: readonly FlowDelta[]): Api.SketchResultT["drawn"] {
  const out: Api.SketchResultT["drawn"] = [];
  for (const d of deltas)
    if (d.why.startsWith("Drawn on the canvas"))
      d.steps.forEach((s, index) =>
        out.push({
          flow: d.flow,
          index,
          what:
            s.op === "remove"
              ? `step ${s.step} removed`
              : `${s.kind ?? s.op}${s.to ? ` → ${s.to.component} ${s.to.entry}` : ""}${s.store ? ` ${s.store.table}` : ""}`,
        }),
      );
  return out;
}

export function uiSketchRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  const changeOf = (v: string) => {
    if (!CHANGE.test(v)) throw badRequest(`${v} isn't a change id.`);
    return v;
  };
  const deltaFiles = async (dir: string): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const f of await readdir(join(dir, TARGET_DIR)).catch(() => [] as string[]))
      if (f.endsWith(".yaml"))
        out.set(f.slice(0, -5), await readFile(join(dir, TARGET_DIR, f), "utf8"));
    return out;
  };
  const commitOf = (change: string) =>
    `git add ${changesRelOf(root)}/${change}/${TARGET_DIR} ${changesRelOf(root)}/${change}/design.md && git commit -m "${safeMessage(`${change}: drawn on the canvas`)}"`;
  return r
    .add("GET", "/api/changes/{changeId}/sketch", async ({ params }) => {
      const change = changeOf(params.changeId!);
      const m = await changeMapOf(root, change);
      if (!m) throw notFound(`There is no change ${change}.`);
      const { deltas } = await readDeltas(join(changesDirOf(root), change));
      return {
        status: 200,
        body: {
          written: false,
          files: [],
          map: changeMapBody(change, m),
          drawn: drawnOf(deltas),
          commit: commitOf(change),
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
        const before = await deltaFiles(dir);
        const { deltas } = await readDeltas(dir);
        const res = applyStroke(deltas, s.data, estate, by);
        if (res.problem)
          return {
            status: 200,
            body: {
              written: false,
              files: [],
              problem: res.problem,
              ...(res.pick ? { pick: res.pick } : {}),
              drawn: drawnOf(deltas),
              commit: commitOf(change),
            } satisfies Api.SketchResultT,
          };
        // The files as the write makes them: the same function, so the preview is the write.
        const rendered = new Map<string, string>();
        for (const d of res.deltas) {
          const own = before.get(d.flow);
          rendered.set(d.flow, renderDelta(d, own, estate, by));
        }
        const files = [...new Set([...res.changed, ...before.keys()])]
          .filter((flow) => res.changed.includes(flow) || !res.deltas.some((d) => d.flow === flow))
          .map((flow) => {
            const was = before.get(flow) ?? "";
            const now = rendered.get(flow) ?? "";
            return {
              file: `${changesRelOf(root)}/${change}/${TARGET_DIR}/${flow}.yaml`,
              changes: changedLines(lfOnly(was), lfOnly(now)),
            };
          })
          .filter((f) => f.changes.length);
        if (b.data.preview)
          return {
            status: 200,
            body: {
              written: false,
              files,
              drawn: drawnOf(res.deltas),
              commit: commitOf(change),
            } satisfies Api.SketchResultT,
          };
        // Another stroke landed meanwhile: nothing is written over it.
        const now = await deltaFiles(dir);
        if (
          [...now.keys()].join() !== [...before.keys()].join() ||
          [...now].some(([k, v]) => before.get(k) !== v)
        )
          throw conflict(
            `${change}'s target flows changed meanwhile: look again, then draw the stroke again.`,
          );
        await writeTargetFlows(dir, { flows: res.deltas }, estate, by);
        for (const f of files) ctx.events.publish({ type: "file.changed", path: f.file });
        const m = await changeMapOf(root, change);
        return {
          status: 200,
          body: {
            written: true,
            files,
            ...(m ? { map: changeMapBody(change, m) } : {}),
            drawn: drawnOf(res.deltas),
            commit: commitOf(change),
          } satisfies Api.SketchResultT,
        };
      });
    });
}

/** A delta as writeTargetFlows writes it (its header and pin), in the file's own line endings. */
function renderDelta(
  d: FlowDelta,
  own: string | undefined,
  estate: Awaited<ReturnType<typeof loadEstate>>,
  by: string,
): string {
  const text = renderDeltaText(d, estate, by);
  return own ? text.replace(/\n/g, eolOf(own)) : text;
}

function renderDeltaText(
  d: FlowDelta,
  estate: Awaited<ReturnType<typeof loadEstate>>,
  by: string,
): string {
  const today = d.change === "new" ? undefined : estate.flowById.get(d.flow)?.flow;
  const pinned: FlowDelta = {
    ...d,
    schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
    ...(today ? { base: { steps: flowBase(today) } } : {}),
  };
  // The same header writeTargetFlows writes, so the preview's lines are the write's.
  return `# The target of flow ${d.flow} (ADR 0087): the steps this change adds, changes or removes. Drafted by ${by}; base pins the version of today's flow it was written against (ADR 0111).\n${stringify(FlowDeltaSchema.parse(pinned), { lineWidth: 0 })}`;
}
