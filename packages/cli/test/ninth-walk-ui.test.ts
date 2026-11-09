import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Api,
  Question,
  QUESTION_SCHEMA_VERSION,
  readQuestion,
  writeQuestion,
} from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";
import { CHANGE, speckitRoot } from "./run-helpers.js";

/**
 * Ninth UX walk (API 2.83.0): the Task board says what a task waits for (its own repo's earlier
 * tasks too), a person names a change's owners per role from its page, and a critic gap's owner
 * question is listed and answered with the owner questions.
 */

const T = 120_000;

function caller(srv: RunningServer) {
  return async (path: string, o: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(srv.url + path, {
      method: o.method ?? "GET",
      headers: {
        "X-Atticus-Token": srv.token,
        ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as any };
  };
}

describe("the Task board and the change's owners", () => {
  it(
    "says a task waits for the earlier task of its repo, and names the owners per role",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      const srv = await startServer({
        root,
        port: 0,
        user: "priya.nair",
        watch: false,
        extend: (r, ctx) => uiQuestionRoutes(uiRoutes(r, ctx), ctx),
      });
      const call = caller(srv);
      try {
        const tasks = z.array(Api.Task).parse((await call(`/api/changes/${CHANGE}/tasks`)).body);
        expect(tasks.find((t) => t.id === "1.1")?.waits).toBeUndefined();
        expect(tasks.find((t) => t.id === "1.2")?.waits).toEqual({
          tasks: ["1.1"],
          sameRepo: ["1.1"],
        });
        const ready = Api.ReadyTasks.parse((await call(`/api/changes/${CHANGE}/tasks/ready`)).body);
        expect(ready.ready).toEqual(["1.1"]);

        const put = await call(`/api/changes/${CHANGE}/owners`, {
          method: "PUT",
          body: { owners: { architect: ["@priya.nair"], "team-lead": ["sam"] } },
        });
        expect(put.status).toBe(200);
        const d = Api.ChangeDetail.parse(put.body);
        expect(d.owners).toMatchObject({ architect: ["priya.nair"], "team-lead": ["sam"] });
        const q = Api.QuestionList.parse((await call(`/api/questions?change=${CHANGE}`)).body);
        expect(q.yourRoles).toEqual(["architecture"]);
        const bad = await call(`/api/changes/${CHANGE}/owners`, {
          method: "PUT",
          body: { owners: { developer: ["dev"] } },
        });
        expect(bad.status).toBe(400);
      } finally {
        await srv.close();
      }
    },
    T,
  );
});

describe("a critic gap's owner question", () => {
  it("is listed with the owner questions, not the steps', and its answer is the person's", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-asked-gap-"));
    const id = "q-0123456789ab";
    await writeQuestion(
      root,
      Question.parse({
        schemaVersion: QUESTION_SCHEMA_VERSION,
        id,
        askedBy: {
          step: "critic-ask",
          command: `atticus finding ${CHANGE} gap-slo-known-ledger ask`,
          at: "2026-11-08T09:00:00Z",
        },
        repo: CHANGE,
        question: "What availability does forge-ledger promise?",
        evidence: [`openspec/changes/${CHANGE}/design.md:3`],
        scope: { level: "repo", id: CHANGE },
        askedOf: "team-ledger",
        finding: { change: CHANGE, gate: "design", round: 1, id: "gap-slo-known-ledger" },
        state: "open",
        rerun: `atticus critic ${CHANGE} --gate design`,
      }),
    );
    const srv = await startServer({
      root,
      port: 0,
      user: "tia",
      watch: false,
      extend: (r, ctx) => uiQuestionRoutes(r, ctx),
    });
    const call = caller(srv);
    try {
      const list = Api.OwnerQuestionList.parse((await call("/api/owner-questions")).body);
      expect(list.open).toBe(1);
      expect(list.questions[0]).toMatchObject({
        id,
        owner: "team-ledger",
        system: CHANGE,
        state: "sent",
        finding: { change: CHANGE, gate: "design", id: "gap-slo-known-ledger" },
      });
      const steps = Api.QuestionList.parse((await call("/api/questions")).body);
      expect(steps.questions.map((q) => q.id)).not.toContain(id);
      const a = await call(`/api/owner-questions/${id}/answer`, {
        method: "POST",
        body: { answer: "99.9% over 30 days" },
      });
      expect(a.status).toBe(200);
      expect(Api.OwnerAnswerResult.parse(a.body).question.state).toBe("answered");
      expect((await readQuestion(root, id))?.answer).toMatchObject({
        text: "99.9% over 30 days",
        by: "tia",
      });
    } finally {
      await srv.close();
    }
  });
});
