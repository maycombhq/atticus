import {
  acceptProposal as acceptProposalOf,
  answerQuestion,
  Api,
  listQuestions,
  QuestionError,
  QuestionState,
  readQuestion,
  TARGETS_STEP_ID,
  TOPICS_STEP_ID,
} from "@maycombhq/core";
import {
  badRequest,
  HttpError,
  notFound,
  strParam,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * The questions API (ADR 0078, C4): read questions/<id>.yaml and write a person's answer to
 * it, through the same functions `atticus questions answer` uses. The list comes in the order
 * to ask (ADR 0140), each question with its owner, and `mine=true` keeps the person's teams'. It never runs the step that
 * asked: the answer comes back with the command to run next.
 */
export function uiQuestionRoutes(r: Router, ctx: ServerContext, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  return (
    r
      .add("GET", "/api/questions", async ({ query }) => {
        const state = strParam(query, "state");
        if (state !== undefined && !QuestionState.safeParse(state).success)
          throw badRequest("state is open, answered or retired.");
        const mine = strParam(query, "mine");
        if (mine !== undefined && mine !== "true") throw badRequest("mine is true, or left out.");
        // beta.21: every question read once and routed once (mine, the person's teams' only); the
        // list is the asked state, the counts every state of the same questions.
        const every = await listQuestions(ctx.root);
        // ADR 0140: in the order to ask them, each with its owner.
        const { routeQuestions } = await import("./question-routing.js");
        const routedAll = await routeQuestions(
          ctx.root,
          every.questions,
          mine ? { mine: ctx.user } : {},
        );
        const base = routedAll.questions;
        const routed = {
          ...routedAll,
          questions: state ? base.filter((q) => q.state === state) : base,
        };
        const listed = { problems: every.problems };
        const n = (s: string) => base.filter((q) => q.state === s).length;
        const body = {
          counts: {
            open: n("open"),
            answered: n("answered"),
            retired: n("retired"),
            total: base.length,
            byRepo: Object.fromEntries(
              [...new Set(base.map((q) => q.repo))].sort().map((r) => {
                const of = base.filter((q) => q.repo === r);
                const k = (s: string) => of.filter((q) => q.state === s).length;
                return [
                  r,
                  {
                    open: k("open"),
                    answered: k("answered"),
                    retired: k("retired"),
                    total: of.length,
                  },
                ];
              }),
            ),
          },
          questions: routed.questions,
          problems: [...listed.problems, ...routed.problems],
          about: routed.about,
          ...(routed.me ? { me: routed.me } : {}),
        };
        return { status: 200, body };
      })
      // UX review (2026-11-08): the knowledge gaps' owner questions, answered on the Questions
      // page by the same function `atticus questions owner` uses.
      .add("GET", "/api/owner-questions", async () => {
        const { ownerQuestions } = await import("./owner-questions.js");
        return { status: 200, body: await ownerQuestions(ctx.root, { now: now() }) };
      })
      .add("POST", "/api/owner-questions/{id}/answer", async ({ params, body }) => {
        const b = Api.OwnerAnswerRequest.safeParse(body ?? {});
        if (!b.success || !b.data.answer.trim())
          throw badRequest('Answer with { answer: "what the owner said" }.');
        const { answerOwnerQuestion, OwnerQuestionError } = await import("./owner-questions.js");
        try {
          const r = await answerOwnerQuestion(ctx.root, params.id!, b.data.answer, {
            by: ctx.user,
            now: now(),
          });
          return { status: 200, body: r };
        } catch (e) {
          if (e instanceof OwnerQuestionError)
            throw e.code === "not-found" ? notFound(e.message) : badRequest(e.message);
          throw e;
        }
      })
      .add("GET", "/api/questions/{id}", async ({ params }) => {
        const q = await readQuestion(ctx.root, params.id!).catch(() => {
          throw new HttpError(
            422,
            "Atticus can't read that question",
            `questions/${params.id}.yaml isn't a valid question.`,
          );
        });
        if (!q) throw notFound(`There is no question ${params.id}.`);
        return { status: 200, body: q };
      })
      // ADR 0162 (F8): the "Another repo…" picker of a targets question.
      .add("GET", "/api/questions/{id}/targets", async ({ params }) => {
        const q = await readQuestion(ctx.root, params.id!).catch(() => undefined);
        if (!q) throw notFound(`There is no question ${params.id}.`);
        if (q.askedBy.step !== TARGETS_STEP_ID && q.askedBy.step !== TOPICS_STEP_ID)
          throw new HttpError(
            422,
            "That question doesn't ask where a call goes or who owns a topic",
            `${q.id} isn't a targets or topics question, so it has no picker.`,
          );
        const { pickerOf } = await import("./target-answer.js");
        return { status: 200, body: { picks: await pickerOf(ctx.root) } };
      })
      // WP7.2: the lines each cited line sits in, so the answer is given looking at the code.
      .add("GET", "/api/questions/{id}/evidence", async ({ params }) => {
        const q = await readQuestion(ctx.root, params.id!).catch(() => undefined);
        if (!q) throw notFound(`There is no question ${params.id}.`);
        const { evidenceExcerpts } = await import("./question-evidence.js");
        return {
          status: 200,
          body: {
            excerpts: await evidenceExcerpts(ctx.root, { repo: q.repo, evidence: q.evidence }),
          },
        };
      })
      .add("POST", "/api/questions/{id}/answer", async ({ params, body }) => {
        const b = Api.AnswerQuestionRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest('Answer with { option: <n> } or { text: "your own words" }.', {
            errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        try {
          // ADR 0144 (Q5): the person accepts the assistant's proposal; it becomes their answer.
          const { acceptProposal, target, addSystem, name, ...given } = b.data;
          // ADR 0162 (F8): a target from the picker, a new system written for review if asked.
          let writeSystem: (() => Promise<import("./target-answer.js").TargetSystem>) | undefined;
          let system: import("./target-answer.js").TargetSystem | undefined;
          if (target) {
            if (acceptProposal || given.option !== undefined || given.text !== undefined)
              throw badRequest("Give target alone, not with option, text or acceptProposal.");
            const q0 = await readQuestion(ctx.root, params.id!).catch(() => undefined);
            if (!q0) throw notFound(`There is no question ${params.id}.`);
            const { targetAnswerOf, offerLine } = await import("./target-answer.js");
            const t = await targetAnswerOf(ctx.root, q0, target, {
              ...(addSystem ? { addSystem } : {}),
              ...(name ? { name } : {}),
            });
            if ("problem" in t)
              throw badRequest(
                [t.problem, ...(t.offer ? [offerLine(q0.id, target, t.offer)] : [])].join(" "),
                t.offer ? { offer: t.offer } : undefined,
              );
            given.text = t.text;
            writeSystem = t.write;
          }
          const r = acceptProposal
            ? await acceptProposalOf(ctx.root, params.id!, {
                ...(given.scope ? { scope: given.scope } : {}),
                ...(given.repoType ? { repoType: given.repoType } : {}),
                ...(given.match ? { match: given.match } : {}),
                by: ctx.user,
                at: now().toISOString(),
              })
            : await answerQuestion(ctx.root, params.id!, {
                ...given,
                // Review item 14: the profile is written only once the answer is accepted.
                ...(writeSystem
                  ? {
                      beforeWrite: async () => {
                        system = await writeSystem!();
                      },
                    }
                  : {}),
                by: ctx.user,
                at: now().toISOString(),
              });
          return {
            status: 200,
            body: {
              question: r.question,
              rerun: r.question.rerun,
              ...(r.skill ? { skill: r.skill } : {}),
              ...(system ? { system } : {}),
            },
          };
        } catch (e) {
          if (!(e instanceof QuestionError)) throw e;
          if (e.code === "not-found") throw notFound(e.message);
          if (e.code === "bad-answer") throw badRequest(e.message);
          throw new HttpError(422, "Atticus can't do that yet", e.message);
        }
      })
  );
}
