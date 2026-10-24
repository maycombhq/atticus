import {
  answerQuestion,
  Api,
  listQuestions,
  QuestionError,
  QuestionState,
  readQuestion,
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
 * it, through the same functions `atticus questions answer` uses. It never runs the step that
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
        const body = await listQuestions(ctx.root, state ? { state: state as QuestionState } : {});
        return { status: 200, body };
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
          const r = await answerQuestion(ctx.root, params.id!, {
            ...b.data,
            by: ctx.user,
            at: now().toISOString(),
          });
          return {
            status: 200,
            body: {
              question: r.question,
              rerun: r.question.rerun,
              ...(r.skill ? { skill: r.skill } : {}),
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
