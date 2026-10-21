import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, Question, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";

const AT = "2026-10-21T12:00:00.000Z";

let root: string;
let srv: RunningServer;
let id: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

/** A metarepo with one open question; the app's user is given, so no Git is read. No network. */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-questions-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const { raised } = await raiseQuestions(
    root,
    [
      QuestionDraft.parse({
        question: "Is docs/ a generated playground or part of the product?",
        options: [
          { label: "Generated", means: "nobody edits it", changes: "the scan leaves docs/ out" },
          { label: "Product", means: "it ships", changes: "the scan reads docs/" },
        ],
        evidence: ["docs/playground.js:1"],
      }),
    ],
    {
      step: "scan-survey",
      repo: "forge-notes",
      command: "atticus scan survey forge-notes",
      rerun: "atticus scan survey forge-notes --force",
      at: AT,
    },
  );
  id = raised[0]!.id;
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    extend: (r, ctx) => uiQuestionRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("the questions API (ADR 0078)", () => {
  it("lists the questions, and only the open ones when asked", async () => {
    const all = await call("GET", "/api/questions");
    expect(all.status).toBe(200);
    expect(Api.QuestionList.parse(all.body).questions.map((q) => q.id)).toEqual([id]);
    const open = await call("GET", "/api/questions?state=open");
    expect((open.body.questions as unknown[]).length).toBe(1);
    expect((await call("GET", "/api/questions?state=maybe")).status).toBe(400);
  });

  it("returns one question, and 404 for one that isn't there", async () => {
    const one = await call("GET", `/api/questions/${id}`);
    expect(one.status).toBe(200);
    expect(Question.parse(one.body).evidence).toEqual(["docs/playground.js:1"]);
    expect((await call("GET", "/api/questions/q-ffffffffffff")).status).toBe(404);
    expect((await call("GET", "/api/questions/not-an-id")).status).toBe(404);
  });

  it("refuses an answer that isn't one option or words", async () => {
    expect((await call("POST", `/api/questions/${id}/answer`, {})).status).toBe(400);
    expect((await call("POST", `/api/questions/${id}/answer`, { option: 7 })).status).toBe(400);
    expect(
      (await call("POST", `/api/questions/${id}/answer`, { option: 1, text: "both" })).status,
    ).toBe(400);
    expect((await call("POST", "/api/questions/q-ffffffffffff/answer", { option: 1 })).status).toBe(
      404,
    );
  });

  it("writes the answer to questions/<id>.yaml as the signed-in person and returns the rerun", async () => {
    const r = await call("POST", `/api/questions/${id}/answer`, { option: 1 });
    expect(r.status).toBe(200);
    const body = Api.AnsweredQuestion.parse(r.body);
    expect(body.rerun).toBe("atticus scan survey forge-notes --force");
    expect(body.question.answer).toMatchObject({ option: 1, by: "priya.nair" });
    const file = Question.parse(
      parse(await readFile(join(root, "questions", `${id}.yaml`), "utf8")),
    );
    expect(file.state).toBe("answered");
    expect(file.answer?.by).toBe("priya.nair");
  });
});
