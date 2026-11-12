import { answerAsJob } from "./ui-api-activity.js";
import { fileStepStore, manualAdapter, type Notifier, type WorkTracker } from "@maycombhq/adapters";
import { changeFolder } from "@maycombhq/changes";
import { Api, changesRelOf, loadOrgPack, orgPackDirOf, readTeams, RecordId } from "@maycombhq/core";
import {
  metarepoAdapters,
  readShape,
  recordShape,
  removeShape,
  SHAPE_FILE,
  ShapeError,
  shapedStories,
  shapeIssues,
  shapeView,
  syncWorkItems,
  type StoriesShape,
  type SyncResult,
} from "@maycombhq/planner";
import {
  badRequest,
  HttpError,
  notFound,
  requireConfirmation,
  strParam,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * Roles and the business analyst (ADR 0191) through the local API: the owners roles.yaml
 * suggests for a change, the plan's work items in the work tracker (manual: a step each), the
 * business analyst's shaping of the stories, an owner question sent through the notify adapter,
 * a knowledge section opened in place, and Ask answered from knowledge too. Files only; every
 * write to a shared system takes the person's confirmation (ADR 0186).
 */

export interface RolesDeps {
  /** Tests: a work tracker (otherwise runtime.yaml's, manual by default). */
  workTracker?: WorkTracker;
  /** Tests: a notifier (otherwise runtime.yaml's). */
  notify?: Notifier;
  now?: () => Date;
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function changeIdOf(v: string): string {
  if (!RecordId.safeParse(v).success)
    throw badRequest(`${JSON.stringify(v.slice(0, 120))} isn't a change id.`);
  return v;
}

export function uiRolesRoutes(r: Router, ctx: ServerContext, deps: RolesDeps = {}): Router {
  const root = ctx.root;
  const now = deps.now ?? (() => new Date());
  // ADR 0191: Ask answers from the organisation's knowledge too, beside the catalog.
  ctx.askKnowledge = async (q) => {
    const { knowledgeAnswerOf } = await import("./roles-work.js");
    return Api.KnowledgeAnswerView.parse(await knowledgeAnswerOf(root, q));
  };
  const exists = async (id: string) => {
    const { access } = await import("node:fs/promises");
    return access(changeFolder(root, id)).then(
      () => true,
      () => false,
    );
  };

  /** The tracker here: a test's, runtime.yaml's live one, or the manual one (steps). */
  const tracker = async (
    change: string,
  ): Promise<{ kind: "none" | "manual" | "live"; wt: WorkTracker }> => {
    const op = await loadOrgPack(orgPackDirOf(root));
    const cfg = op.runtime.adapters.workTracker;
    const manual = () =>
      manualAdapter(
        "workTracker",
        { store: fileStepStore(root), root, change, procedures: op.procedures },
        cfg?.settings ?? {},
      ) as WorkTracker;
    if (deps.workTracker)
      return { kind: cfg?.type === "manual" ? "manual" : "live", wt: deps.workTracker };
    if (!cfg) return { kind: "none", wt: manual() };
    if (cfg.type === "manual") return { kind: "manual", wt: manual() };
    const live = (await metarepoAdapters(root, { change })).workTracker;
    return live ? { kind: "live", wt: live } : { kind: "manual", wt: manual() };
  };
  const planOf = (
    change: string,
    kind: "none" | "manual" | "live",
    res: SyncResult,
  ): Api.WorkItemPlanT => {
    const storyOf = new Map<string, string>();
    return {
      change,
      tracker: kind,
      items: res.writes.map((w) => {
        if (w.type === "story") storyOf.set(w.key, w.key);
        return {
          key: w.key,
          type: w.type,
          title: w.title,
          action: w.action,
          ...(w.id ? { id: w.id } : {}),
          ...(w.id?.startsWith("manual:") ? { step: w.id.slice("manual:".length) } : {}),
          ...(w.type === "story" ? { story: w.key } : {}),
        };
      }),
      command: `atticus ado sync ${change} --approve ${ctx.user}`,
    };
  };
  const shapeAnswer = async (
    change: string,
    shape?: StoriesShape,
  ): Promise<Api.StoryShapeViewT> => {
    const s = shape ?? (await readShape(changeFolder(root, change)));
    // ADR 0191 review: applied once, to the stories as drafted before any shaping.
    const shaped = await shapedStories(root, change, s);
    const v = shapeView(s, shaped);
    return Api.StoryShapeView.parse({
      change,
      file: `${changesRelOf(root)}/${change}/${SHAPE_FILE}`,
      entries: v.entries.map(({ applied, ...e }) => ({
        ...e,
        state: applied ? "applied" : "waiting",
      })),
      assigned: v.assigned,
      uncovered: shaped ? shapeIssues(shaped, s) : [],
      command: `atticus plan stories ${change}`,
    });
  };

  return (
    r
      // ------------------------------------------------------------ owners from roles.yaml
      .add("GET", "/api/changes/{changeId}/owners/suggested", async ({ params }) => {
        const id = changeIdOf(params.changeId!);
        if (!(await exists(id))) throw notFound(`There is no change ${id}.`);
        const { ownerSuggestions } = await import("./roles-work.js");
        return {
          status: 200,
          body: Api.OwnerSuggestionList.parse(await ownerSuggestions(root, id)),
        };
      })

      // ------------------------------------------------------------ the plan's work items
      .add("GET", "/api/changes/{changeId}/work-items", async ({ params }) => {
        const id = changeIdOf(params.changeId!);
        if (!(await exists(id))) throw notFound(`There is no change ${id}.`);
        const t = await tracker(id);
        try {
          const res = await syncWorkItems(root, id, { workTracker: t.wt, dryRun: true });
          return { status: 200, body: planOf(id, t.kind, res) };
        } catch (e) {
          throw new HttpError(422, "Atticus can't list them yet", (e as Error).message);
        }
      })
      .add("POST", "/api/changes/{changeId}/work-items", async ({ params, body }) => {
        const id = changeIdOf(params.changeId!);
        if (!(await exists(id))) throw notFound(`There is no change ${id}.`);
        const b = Api.WorkItemSyncRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Send { confirmation? }.");
        const t = await tracker(id);
        if (t.kind === "none")
          throw new HttpError(
            422,
            "No work tracker is set up",
            "runtime.yaml names no work tracker: set adapters.workTracker on Set up (type manual works with no integration: each work item is a step for you).",
          );
        // A live tracker is a shared system: the person's confirmation. Manual writes steps only.
        if (t.kind === "live")
          requireConfirmation(ctx.confirmations, "work-items", id, b.data.confirmation);
        const at = stamp(now());
        const sync = async () => {
          const res = await syncWorkItems(root, id, {
            workTracker: t.wt,
            approve: (w) => ({ by: ctx.user.replace(/^@/, ""), at, ref: w.key }),
            now: at,
          });
          const plan = await syncWorkItems(root, id, { workTracker: t.wt, dryRun: true });
          ctx.events.publish({
            type: "file.changed",
            path: `${changesRelOf(root)}/${id}/sync.yaml`,
          });
          const lines = [
            ...res.done.map((d) =>
              d.id.startsWith("manual:")
                ? `${d.key}: a step for you (Home › Manual steps): create it in the tracker, then record its id there.`
                : `${d.action === "create" ? "Created" : "Updated"} ${d.key}: ${d.id}.`,
            ),
            ...res.skipped.map((s) => `Skipped ${s.key}: ${s.reason}.`),
          ];
          return Api.WorkItemSyncResult.parse({
            plan: planOf(id, t.kind, plan),
            lines,
            done: res.done,
            failed: res.failed,
          });
        };
        const answer = () =>
          sync().catch((e: unknown) => {
            if (e instanceof HttpError) throw e;
            throw new HttpError(422, "Atticus refused", (e as Error).message);
          });
        // Review of beta.23: a live tracker is called per item, longer than an editor panel
        // waits for one answer; with `job: true` the sync is a job the Console shows, and the
        // job's result is this answer.
        if (b.data.job) return answerAsJob(ctx, `Putting work items in the tracker: ${id}`, answer);
        return { status: 200, body: await answer() };
      })

      // ------------------------------------------------------------ the BA shapes the stories
      .add("GET", "/api/changes/{changeId}/stories/shape", async ({ params }) => {
        const id = changeIdOf(params.changeId!);
        if (!(await exists(id))) throw notFound(`There is no change ${id}.`);
        return { status: 200, body: await shapeAnswer(id) };
      })
      .add("POST", "/api/changes/{changeId}/stories/shape", async ({ params, body }) => {
        const id = changeIdOf(params.changeId!);
        if (!(await exists(id))) throw notFound(`There is no change ${id}.`);
        const b = Api.StoryShapeRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest(
            "Say what to do: { op: rename | split | merge | add, story?, stories?, name, words?, parts? }.",
            { errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
          );
        try {
          const { shape } = await recordShape(changeFolder(root, id), b.data, {
            by: ctx.user,
            at: stamp(now()),
          });
          ctx.events.publish({
            type: "file.changed",
            path: `${changesRelOf(root)}/${id}/${SHAPE_FILE}`,
          });
          return { status: 201, body: await shapeAnswer(id, shape) };
        } catch (e) {
          if (!(e instanceof ShapeError)) throw e;
          if (e.code === "not-found") throw notFound(e.message);
          throw new HttpError(422, "Atticus can't do that yet", e.message);
        }
      })
      .add("POST", "/api/changes/{changeId}/stories/shape/{entryId}/remove", async ({ params }) => {
        const id = changeIdOf(params.changeId!);
        if (!(await exists(id))) throw notFound(`There is no change ${id}.`);
        try {
          const shape = await removeShape(changeFolder(root, id), params.entryId!);
          ctx.events.publish({
            type: "file.changed",
            path: `${changesRelOf(root)}/${id}/${SHAPE_FILE}`,
          });
          return { status: 200, body: await shapeAnswer(id, shape) };
        } catch (e) {
          if (!(e instanceof ShapeError)) throw e;
          if (e.code === "not-found") throw notFound(e.message);
          throw new HttpError(422, "Atticus can't do that", e.message);
        }
      })

      // ------------------------------------------------------------ an owner question, sent
      .add("POST", "/api/owner-questions/{id}/send", async ({ params, body }) => {
        const b = Api.SendOwnerAskRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Send { confirmation? }.");
        const { ownerQuestions } = await import("./owner-questions.js");
        const list = await ownerQuestions(root, { now: now() });
        const q = list.questions.find((x) => x.id === params.id);
        if (!q) throw notFound(`There is no owner question ${params.id}.`);
        const { notifierFor } = await import("./roles-work.js");
        const n = await notifierFor(root, q.finding?.change, deps.notify);
        const to = q.owner;
        if (!n.notify || n.kind === "none")
          return {
            status: 200,
            body: Api.SentOwnerAsk.parse({
              state: "not-sent",
              to,
              why: "No notifications are set up here (runtime.yaml adapters.notify): copy the question and ask the owner, then record what they said.",
            }),
          };
        if (n.kind === "live")
          requireConfirmation(ctx.confirmations, "owner-ask", q.id, b.data.confirmation);
        const team = (await readTeams(root)).teams.find((t) => t.id === to);
        const mentions = team
          ? team.people.map((p) => p.replace(/^@/, ""))
          : [to.replace(/^@/, "")];
        const channel =
          q.channel && q.channel !== "Atticus" ? q.channel : `@${to.replace(/^@/, "")}`;
        try {
          const sent = await n.notify.send(
            {
              channel,
              title: `A question for ${team?.name ?? to}`,
              body: `${q.question}\n\nWhat it is for: ${q.neededFact}\n\nAnswer it in Atticus (Questions › Owner questions), or reply to ${ctx.user}.`,
              mentions,
            },
            { by: ctx.user.replace(/^@/, ""), at: stamp(now()), ref: `owner-ask:${q.id}` },
          );
          // Review of the fix: sent is on file, so the card says Sent (and when) from now on.
          if (n.kind !== "manual") {
            const { recordOwnerAsk } = await import("./owner-questions.js");
            await recordOwnerAsk(root, q.id, { at: stamp(now()), to }).catch(() => undefined);
          }
          return {
            status: 200,
            body: Api.SentOwnerAsk.parse({
              state: n.kind === "manual" ? "step" : "sent",
              to,
              id: sent.id,
              ...(n.kind === "manual"
                ? {
                    why: "Notifications are manual here: sending it is a step for you (Home › Manual steps).",
                  }
                : {}),
            }),
          };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          return {
            status: 200,
            body: Api.SentOwnerAsk.parse({
              state: "not-sent",
              to,
              why: `The notify adapter refused: ${(e as Error).message}`,
            }),
          };
        }
      })

      // ------------------------------------------------------------ a section, in place
      .add("GET", "/api/knowledge/passage", async ({ query }) => {
        const id = strParam(query, "id")?.trim();
        if (!id || id.length > 400 || /[\p{Cc}]/u.test(id))
          throw badRequest("Say which section: ?id=<source>/<page>#<heading>.");
        const { passageOf } = await import("./roles-work.js");
        const p = await passageOf(root, id);
        if (!p) throw notFound(`No page or section ${id} is in a snapshot or in inputs/.`);
        return { status: 200, body: Api.KnowledgePassageView.parse(p) };
      })
  );
}
