import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Api, changesRelOf } from "@maycombhq/core";
import { changeFolder } from "@maycombhq/changes";
import {
  addCorrection,
  CORRECTIONS_FILE,
  draftItems,
  draftProvenance,
  PlannerError,
  readCorrections,
  readStageLoop,
  removeCorrection,
  rerunOf,
  STAGES,
  type Correction,
  type Provenance,
  type Stage,
} from "@maycombhq/planner";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * ADR 0181 (stage drafts, C4 2.79.0): AI decides first, a person corrects, and the AI corrects
 * the rest like it. GET /api/changes/{id}/drafts/{page} gives a page's stage drafts with who wrote
 * each last (stage/drafted.yaml, the stages' loop files' hashes as a fallback) and the items a
 * person can correct; the corrections routes list, add and take back a person's corrections
 * (stage/corrections.yaml), which the stage's next run reads as the person's word. The app runs
 * no stage and no git: it shows the commands.
 */

type Page = Api.StageDraftsViewT["page"];

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CORRECTION_ID = /^c-[0-9a-f]{10}$/;

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The stage each page's drafts come from, when nothing on file says otherwise. */
const PAGE_STAGE: Record<Page, Stage> = {
  feature: "feature",
  architecture: "architecture",
  stories: "stories",
  tasks: "stories",
};

/** Which of a change's files are each page's drafts. */
const ON_PAGE: Record<Page, (f: string) => boolean> = {
  feature: (f) => f === "feature.md" || f === "proposal.md",
  architecture: (f) =>
    /^target-flows\/[^/]+\.ya?ml$/.test(f) || f === "design.md" || f === "data.md",
  stories: (f) =>
    f === "stories.md" || /^stories\/[^/]+\.md$/.test(f) || /^specs\/.+\/spec\.md$/.test(f),
  tasks: (f) => f === "tasks.md",
};

const pageOfFile = (f: string): Page | undefined =>
  (Object.keys(ON_PAGE) as Page[]).find((p) => ON_PAGE[p](f));

async function walk(dir: string, sub = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".")) continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (["stage", "review", "tasks", "inputs"].includes(rel)) continue;
      out.push(...(await walk(dir, rel)));
    } else out.push(rel);
  }
  return out;
}

const slashOf = (stage: Stage, change: string) =>
  `/atticus-${stage === "small" ? "small" : stage} ${change}`;

const nextOf = (stage: Stage, change: string) => ({
  stage,
  command: rerunOf(stage, change),
  slash: slashOf(stage, change),
});

const view = (c: Correction): Api.CorrectionViewT => ({ ...c });

/** The stages' loop files' hashes, for a change drafted before drafted.yaml was kept. */
async function writtenByStage(dir: string, change: string) {
  const out: { stage: Stage; hashes: Record<string, string> }[] = [];
  for (const s of STAGES) {
    const l = await readStageLoop(dir, change, s).catch(() => undefined);
    if (l?.present && l.loop.written) out.push({ stage: s, hashes: l.loop.written });
  }
  return out;
}

const provenanceView = (p: Provenance): Api.DraftProvenanceT => ({ ...p });

/** A page's stage drafts: the files a stage wrote (or a person saved), with their items. */
export async function stageDraftsView(
  root: string,
  change: string,
  page: Page,
): Promise<Api.StageDraftsViewT> {
  const dir = changeFolder(root, change);
  const rel = `${changesRelOf(root)}/${change}`;
  const problems: { file: string; message: string }[] = [];
  const candidates = (await walk(dir)).filter(ON_PAGE[page]).sort();
  const prov = await draftProvenance(
    dir,
    change,
    candidates,
    await writtenByStage(dir, change),
  ).catch((e: unknown) => {
    problems.push({ file: `${rel}/stage/drafted.yaml`, message: String((e as Error).message) });
    return {} as Record<string, Provenance>;
  });
  const files: Api.DraftFileViewT[] = [];
  for (const f of candidates) {
    const p = prov[f];
    // Only a stage's draft: a file a stage wrote, or one a person saved as one.
    if (!p) continue;
    const text = (await readFile(join(dir, ...f.split("/")), "utf8").catch(() => "")) ?? "";
    files.push({
      file: f,
      path: `${rel}/${f}`,
      stage: p.by === "ai" ? p.stage : PAGE_STAGE[page],
      drafted: provenanceView(p),
      items: draftItems(f, text),
    });
  }
  let corrections: Correction[] = [];
  try {
    corrections = await readCorrections(dir, change);
  } catch (e) {
    problems.push({ file: `${rel}/${CORRECTIONS_FILE}`, message: String((e as Error).message) });
  }
  const mine = corrections
    .filter((c) => ON_PAGE[page](c.file))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const waiting = mine.find((c) => c.state === "waiting");
  return {
    change,
    page,
    files,
    corrections: mine.map(view),
    next: nextOf(waiting?.stage ?? PAGE_STAGE[page], change),
    problems,
  };
}

function pageOf(v: string): Page {
  const r = Api.DraftPage.safeParse(v);
  if (!r.success)
    throw badRequest(
      `${JSON.stringify(v)} isn't a page of drafts: feature, architecture, stories or tasks.`,
    );
  return r.data;
}

const refusal = (e: unknown): never => {
  if (e instanceof PlannerError && e.code === "refused") throw conflict(e.message);
  if (e instanceof PlannerError) throw new HttpError(422, "Atticus refused", e.message);
  throw e;
};

export function uiDraftRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  const changeOf = async (v: string) => {
    if (!ID.test(v)) throw badRequest(`${JSON.stringify(v)} isn't a change id.`);
    if (!(await exists(join(changeFolder(ctx.root, v), "change.yaml"))))
      throw notFound(`There is no change ${v}.`);
    return v;
  };
  const list = async (change: string): Promise<Api.CorrectionListT> => ({
    change,
    corrections: (await readCorrections(changeFolder(ctx.root, change), change).catch(refusal)).map(
      view,
    ),
  });
  return r
    .add("GET", "/api/changes/{changeId}/drafts/{page}", async ({ params }) => {
      const page = pageOf(params.page!);
      const change = await changeOf(params.changeId!);
      return { status: 200, body: await stageDraftsView(ctx.root, change, page) };
    })
    .add("GET", "/api/changes/{changeId}/corrections", async ({ params }) => {
      const change = await changeOf(params.changeId!);
      return { status: 200, body: await list(change) };
    })
    .add("POST", "/api/changes/{changeId}/corrections", async ({ params, body }) => {
      const change = await changeOf(params.changeId!);
      const b = Api.AddCorrectionRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say which draft (file, and item) and write the correction: { file, item, text }.",
          {
            errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        );
      const page = pageOfFile(b.data.file);
      if (!page) throw notFound(`${b.data.file} isn't a stage draft of ${change}.`);
      const v = await stageDraftsView(ctx.root, change, page);
      const f = v.files.find((x) => x.file === b.data.file);
      if (!f) throw notFound(`${b.data.file} isn't a stage draft of ${change}.`);
      const item = b.data.item ? f.items.find((i) => i.id === b.data.item) : undefined;
      if (b.data.item && !item)
        throw notFound(
          `${b.data.file} has no item ${b.data.item} now: reload the page, then correct it again.`,
        );
      const stage = f.stage as Stage;
      const dir = changeFolder(ctx.root, change);
      // Nothing would read a correction before its stage has run.
      const { present } = await readStageLoop(dir, change, stage);
      if (!present)
        throw conflict(
          `The ${stage} stage of ${change} hasn't run here yet, so nothing would read a correction: run ${rerunOf(stage, change)} first.`,
        );
      const c = await addCorrection(dir, change, {
        stage,
        file: f.file,
        ...(item ? { item: item.id } : {}),
        label: item?.label ?? f.file,
        text: b.data.text,
        similar: b.data.similar,
        ...(b.data.like ? { like: b.data.like } : item?.like?.[0] ? { like: item.like[0] } : {}),
        by: ctx.user,
        at: now().toISOString(),
      }).catch(refusal);
      const written = `${changesRelOf(ctx.root)}/${change}/${CORRECTIONS_FILE}`;
      ctx.events.publish({ type: "file.changed", path: written });
      const result: Api.CorrectionResultT = {
        correction: view(c),
        files: [written],
        commit: `git add ${written}\ngit commit -m "${change}: a correction of ${f.file}"`,
        next: nextOf(stage, change),
      };
      return { status: 200, body: result };
    })
    .add(
      "POST",
      "/api/changes/{changeId}/corrections/{correctionId}/remove",
      async ({ params }) => {
        const change = await changeOf(params.changeId!);
        const id = params.correctionId!;
        if (!CORRECTION_ID.test(id))
          throw badRequest(`${JSON.stringify(id)} isn't a correction id.`);
        const gone = await removeCorrection(changeFolder(ctx.root, change), change, id).catch(
          refusal,
        );
        if (!gone) throw notFound(`Change ${change} has no correction ${id}.`);
        ctx.events.publish({
          type: "file.changed",
          path: `${changesRelOf(ctx.root)}/${change}/${CORRECTIONS_FILE}`,
        });
        return { status: 200, body: await list(change) };
      },
    );
}
