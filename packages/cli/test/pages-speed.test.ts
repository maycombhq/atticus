import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiFactsRoutes } from "../src/ui-api-facts.js";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";

/**
 * G7 (beta.21): the Questions page and a repo's evidence at a real estate's size. 40 Forge repos
 * with 2,500 facts each and 400 open questions. The first look reads them; a look after that,
 * with nothing changed, must come back inside the budget (generous, so CI machines pass).
 */
const REPOS = 40;
const FACTS = 2500;
const QUESTIONS_PER_REPO = 10;
const BUDGET_MS = 1500;

let srv: RunningServer;

const callFact = (repo: string, i: number) =>
  JSON.stringify({
    kind: "call",
    id: `c-op-${i}`,
    repo,
    commit: "1111aaa",
    callType: "rest",
    method: "GET",
    path: `/v1/items-${i}/{id}`,
    from: "e-main",
    cite: {
      file: `src/main/java/forge/Client${i % 50}.java`,
      line: 10 + (i % 400),
      value: `/v1/items-${i}/{id}`,
      quote: `restTemplate.getForObject("/v1/items-${i}/{id}", Item.class);`,
    },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-pages-speed-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await mkdir(join(root, "facts"), { recursive: true });
  for (let r = 0; r < REPOS; r++) {
    const repo = `forge-svc-${r}`;
    const lines: string[] = [];
    for (let i = 0; i < FACTS; i++) lines.push(callFact(repo, i));
    await writeFile(join(root, "facts", `${repo}.jsonl`), lines.join("\n") + "\n");
    await raiseQuestions(
      root,
      Array.from({ length: QUESTIONS_PER_REPO }, (_, q) =>
        QuestionDraft.parse({
          question: `Which system serves GET /v1/items-${q}/{id} for ${repo}?`,
          options: [
            { label: "forge-ledger", means: "the ledger serves it", changes: "the call joins it" },
            { label: "Outside", means: "a vendor", changes: "the call is drawn outside" },
          ],
          evidence: [`src/main/java/forge/Client${q}.java:${10 + q}`],
        }),
      ),
      {
        step: "scan-survey",
        repo,
        command: `atticus scan survey ${repo}`,
        rerun: `atticus scan survey ${repo} --force`,
        at: "2026-11-06T12:00:00.000Z",
      },
    );
  }
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiFactsRoutes(uiQuestionRoutes(r, ctx), ctx),
  });
}, 300_000);
afterAll(() => srv?.close());

const timed = async (path: string) => {
  const t = performance.now();
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  const body = (await r.json()) as unknown;
  return { ms: performance.now() - t, status: r.status, body };
};

describe("pages at a real estate's size (G7)", () => {
  it("lists 400 questions with their counts, and again inside the budget", async () => {
    const first = await timed("/api/questions?state=open");
    expect(first.status).toBe(200);
    const list = Api.QuestionList.parse(first.body);
    expect(list.counts?.open).toBe(REPOS * QUESTIONS_PER_REPO);
    const again = await timed("/api/questions?state=open");
    expect(again.status).toBe(200);
    expect(again.ms).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it("gives a repo's evidence (2,500 facts), and again inside the budget", async () => {
    const first = await timed("/api/facts/forge-svc-7");
    expect(first.status).toBe(200);
    const again = await Promise.all(
      Array.from({ length: 10 }, (_, r) => timed(`/api/facts/forge-svc-${r}`)),
    );
    const second = await Promise.all(
      Array.from({ length: 10 }, (_, r) => timed(`/api/facts/forge-svc-${r}`)),
    );
    for (const a of [...again, ...second]) expect(a.status).toBe(200);
    expect(Math.max(...second.map((s) => s.ms))).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
