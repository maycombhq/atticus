import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { QuestionDraft, questionFromDraft, readQuestion, writeQuestion } from "@maycombhq/core";
import { questionRouteCommand } from "../src/question-route.js";

/** ADR 0189: atticus questions route <id> --to <role>, as the app's Route does. */

it("moves a question to the product owner, says from whom, and refuses a role that isn't one", async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-route-cli-"));
  const q = questionFromDraft(
    QuestionDraft.parse({
      question: "What happens when the account has too little money on the day?",
      evidence: ["openspec/changes/add-holds/brief.md:3"],
    }),
    {
      step: "change-feature",
      repo: "add-holds",
      command: "atticus change feature add-holds",
      rerun: "atticus change feature add-holds",
      at: "2026-11-09T09:00:00Z",
    },
  );
  await writeQuestion(root, q);
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const argv = ["questions", "route", q.id, "--to", "product", "--by", "ari"];
  expect(
    await questionRouteCommand(root, argv, io, { now: new Date("2026-11-09T10:00:00Z") }),
  ).toBe(0);
  expect(out).toEqual([`${q.id} goes to the product owner now (it was the architect's).`]);
  expect((await readQuestion(root, q.id))?.routed).toEqual({
    from: "architecture",
    by: "ari",
    at: "2026-11-09T10:00:00Z",
  });
  expect(await questionRouteCommand(root, ["questions", "route", q.id, "--to", "boss"], io)).toBe(
    2,
  );
  expect(
    await questionRouteCommand(
      root,
      ["questions", "route", "q-000000000000", "--to", "product", "--by", "x"],
      io,
    ),
  ).toBe(1);
});
