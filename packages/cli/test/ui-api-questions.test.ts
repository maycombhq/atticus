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
    // beta.21: the counts are every question's, whichever state was listed, and per repo.
    const counts = Api.QuestionList.parse(open.body).counts!;
    const everyQ = Api.QuestionList.parse(all.body).questions;
    expect(counts.total).toBe(everyQ.length);
    expect(counts.open).toBe(everyQ.filter((q) => q.state === "open").length);
    expect(Object.values(counts.byRepo!).reduce((n, c) => n + c.total, 0)).toBe(everyQ.length);
  });

  it("says who each question goes to, and with mine=true keeps the person's teams' (ADR 0140)", async () => {
    const all = Api.QuestionList.parse((await call("GET", "/api/questions")).body);
    expect(all.about?.[id]).toEqual({
      restsOn: [],
      joins: 0,
      owner: { none: "no repos.manifest.yaml lists forge-notes, so no team owns it" },
    });
    const mine = Api.QuestionList.parse((await call("GET", "/api/questions?mine=true")).body);
    expect(mine.me).toEqual({ handle: "priya.nair", teams: [] });
    expect(mine.questions).toEqual([]);
    // The counts are of the same questions: none of them is mine.
    expect(mine.counts).toMatchObject({ open: 0, total: 0 });
    expect((await call("GET", "/api/questions?mine=yes")).status).toBe(400);
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

describe("the rule several open target questions share (2.49.0, ADR 0168)", () => {
  it("is on each question's about, so the app pre-fills the rule field", async () => {
    const { cp } = await import("node:fs/promises");
    const fix = join(__dirname, "..", "..", "..", "fixtures", "link-estate", "gateway-questions");
    const gw = await mkdtemp(join(tmpdir(), "atticus-ui-questions-rule-"));
    await cp(join(fix, "org-pack"), join(gw, "org-pack"), { recursive: true });
    await cp(join(fix, "questions"), join(gw, "questions"), { recursive: true });
    await cp(join(fix, "facts"), join(gw, "facts"), { recursive: true });
    const s = await startServer({
      root: gw,
      port: 0,
      user: "priya.nair",
      extend: (r, ctx) => uiQuestionRoutes(r, ctx),
    });
    try {
      const r = await fetch(`${s.url}/api/questions?state=open`, {
        headers: { "X-Atticus-Token": s.token },
      });
      const list = Api.QuestionList.parse(await r.json());
      expect(list.about?.["q-848df3a174aa"]?.rule).toEqual({
        match: "/accounts/**",
        ids: ["q-65f2e458d42d", "q-848df3a174aa", "q-977303dcd756"],
        calls: 3,
      });
      expect(list.about?.["q-95d4b60a5cd0"]?.rule).toBeUndefined();
    } finally {
      s.close();
    }
  });
});
