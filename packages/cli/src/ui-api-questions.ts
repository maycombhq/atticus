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
        const listed = await listQuestions(
          ctx.root,
          state ? { state: state as QuestionState } : {},
        );
        // ADR 0140: in the order to ask them, each with its owner; mine, the person's teams' only.
        const { routeQuestions } = await import("./question-routing.js");
        const routed = await routeQuestions(
          ctx.root,
          listed.questions,
          mine ? { mine: ctx.user } : {},
        );
        const body = {
          questions: routed.questions,
          problems: [...listed.problems, ...routed.problems],
          about: routed.about,
          ...(routed.me ? { me: routed.me } : {}),
        };
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
          let system:
            Awaited<ReturnType<typeof import("./target-answer.js").targetAnswerOf>> | undefined;
          if (target) {
            if (acceptProposal || given.option !== undefined || given.text !== undefined)
              throw badRequest("Give target alone, not with option, text or acceptProposal.");
            const q0 = await readQuestion(ctx.root, params.id!).catch(() => undefined);
            if (!q0) throw notFound(`There is no question ${params.id}.`);
            const { targetAnswerOf, offerLine } = await import("./target-answer.js");
            system = await targetAnswerOf(ctx.root, q0, target, {
              ...(addSystem ? { addSystem } : {}),
              ...(name ? { name } : {}),
            });
            if ("problem" in system)
              throw badRequest(
                [
                  system.problem,
                  ...(system.offer ? [offerLine(q0.id, target, system.offer)] : []),
                ].join(" "),
                system.offer ? { offer: system.offer } : undefined,
              );
            given.text = system.text;
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
                by: ctx.user,
                at: now().toISOString(),
              });
          return {
            status: 200,
            body: {
              question: r.question,
              rerun: r.question.rerun,
              ...(r.skill ? { skill: r.skill } : {}),
              ...(system && "system" in system && system.system ? { system: system.system } : {}),
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
