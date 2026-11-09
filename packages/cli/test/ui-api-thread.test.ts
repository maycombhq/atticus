import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { Api, Finding, readQuestion, REVIEW_SCHEMA_VERSION } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { answerSummary, stageRuns, stageStep, uiThreadRoutes } from "../src/ui-api-thread.js";
import { allRuns } from "../src/runs-view.js";

/**
 * ADR 0188: a stage is one conversation. GET /api/changes/{id}/stages/{stage}/thread assembles a
 * stage's thread from the files that hold it (its runs and their prompts and answers, the loop
 * file, the critic's latest round, the questions, the replies, the questions that couldn't be
 * kept), in order; POST writes a reply, a comment on a finding, or keeps a dropped question. On
 * the Forge metarepo (invented).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;
const NOW = new Date("2026-11-09T10:00:00Z");

let srv: RunningServer;
let root: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const thread = async (stage: string) =>
  Api.StageThreadView.parse(
    (await call("GET", `/api/changes/${CHANGE}/stages/${stage}/thread`)).body,
  );

async function run(
  id: string,
  agent: string,
  state: string,
  startedAt: string,
  o: { output?: string; answer?: string; errors?: string[] } = {},
) {
  const dir = join(root, ".runs", CHANGE, id);
  await mkdir(dir, { recursive: true });
  const output = o.output ?? "stories-answer.yaml";
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change: CHANGE,
        agent: { id: agent, description: "d" },
        pack: { prompt: "the pack" },
        outputPath: output,
        outputIn: "run",
      },
      runtime: "hand-off",
      state,
      attempt: 1,
      startedAt,
      ...(state === "validated" || state === "failed"
        ? { finishedAt: startedAt.replace(":00Z", ":30Z") }
        : {}),
      errors: o.errors ?? [],
    }),
  );
  await writeFile(join(dir, "prompt.md"), `# ${agent}: write ${output}\n\nWrite the result.\n`);
  if (o.answer !== undefined) await writeFile(join(dir, output), o.answer);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-thread-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  // The stories stage ran: a draft answered and checked, a critic finding at the plan gate, a
  // question the assistant raised whose line didn't match, and a new prompt waiting.
  await run("run-20261109090000-0001", "story-writer-flows", "validated", "2026-11-09T09:00:00Z", {
    answer: "stories:\n  - id: s1\n  - id: s2\nsummary: Two stories\n",
  });
  await run("run-20261109090500-0001", "complete-critic", "validated", "2026-11-09T09:05:00Z", {
    output: "findings.yaml",
    answer: "findings: []\n",
  });
  await run("run-20261109091000-0001", "story-writer-flows", "waiting", "2026-11-09T09:10:00Z");
  const f = Finding.parse({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    change: CHANGE,
    gate: "plan",
    round: 1,
    rule: "review.outcome-has-story",
    layer: "org",
    lens: "complete",
    artifact: "interfaces.md",
    locator: { line: 3 },
    summary: "The refusal outcome has no story.",
    why: "Every outcome needs a story.",
    fix: { text: "Add a story for refusing a transfer." },
    evidence: [{ source: "artifact", path: "interfaces.md", line: 3, quote: "x" }],
    waivable: false,
    createdAt: "2026-11-09T09:06:00Z",
    id: "f-0000000a",
    severity: "blocking",
    kind: "issue",
  });
  await mkdir(join(root, REL, "review/plan/1"), { recursive: true });
  await writeFile(join(root, REL, "review/plan/1/f-0000000a.yaml"), stringify(f));
  await mkdir(join(root, REL, "stage"), { recursive: true });
  await writeFile(
    join(root, REL, "stage/stories.yaml"),
    stringify({
      schemaVersion: 1,
      change: CHANGE,
      stage: "stories",
      iteration: 1,
      state: "drafting",
      updatedAt: "2026-11-09T09:07:00Z",
      written: { "stories.md": "a".repeat(64) },
      critic: [{ gate: "plan", round: 1 }],
      dropped: [
        {
          key: "0123456789ab",
          question: "Does a refusal notify the account owner?",
          evidence: [`${REL}/brief.md:999`],
          nearest: `${REL}/brief.md:3`,
          iteration: 1,
          at: "2026-11-09T09:08:00Z",
        },
      ],
    }),
  );
  srv = await startServer({
    root,
    port: 0,
    user: "priya",
    watch: false,
    extend: (r, ctx) => uiThreadRoutes(r, ctx, { now: () => NOW }),
  });
});
afterAll(async () => srv?.close());

describe("GET .../stages/{stage}/thread", () => {
  it("is the stage's prompts, answers, finding and dropped question, in order, waiting on the newest prompt", async () => {
    const v = await thread("stories");
    expect(v.state).toBe("waiting");
    expect(v.headline).toMatch(/^The prompt below waits for your assistant/);
    expect(v.waiting?.runId).toBe("run-20261109091000-0001");
    expect(v.items.map((i) => i.kind)).toEqual([
      "prompt",
      "answer",
      "prompt",
      "answer",
      "finding",
      "changed",
      "dropped",
      "prompt",
      "note",
    ]);
    const answer = v.items[1] as Extract<Api.ThreadItemT, { kind: "answer" }>;
    expect(answer).toMatchObject({ who: "drafter", checked: "passed", by: "person" });
    expect(answer.summary).toEqual(["stories: 2", "summary: Two stories"]);
    expect((v.items[2] as { who: string }).who).toBe("critic");
    // interfaces.md isn't a file the stories stage's assistant writes: Fix opens it at its line.
    const finding = v.items[4] as Extract<Api.ThreadItemT, { kind: "finding" }>;
    expect(finding.assistantWrites).toBe(false);
    expect(finding.edit).toEqual({ artifact: "interfaces", line: 3 });
    expect((v.items.at(-1) as { text: string }).text).toBe(
      "1 question couldn't be kept: its line didn't match.",
    );
    expect(v.step).toEqual(["plan", "stories", CHANGE]);
    expect(v.reply.open).toBe(true);
    // The prompt's size, model and files are details, never the thread's words.
    const prompt = v.items[0] as Extract<Api.ThreadItemT, { kind: "prompt" }>;
    expect(prompt.details.promptPath).toBe(`.runs/${CHANGE}/run-20261109090000-0001/prompt.md`);
  });

  it("a stage that hasn't run says so, and takes no reply yet", async () => {
    const v = await thread("architecture");
    expect(v.state).toBe("not-started");
    expect(v.items).toEqual([]);
    expect(v.reply).toMatchObject({ open: false });
    expect(v.headline).toMatch(/hasn't started/);
  });

  it("refuses a stage that isn't one, and a change that isn't there", async () => {
    expect((await call("GET", `/api/changes/${CHANGE}/stages/tasks/thread`)).status).toBe(400);
    expect((await call("GET", `/api/changes/nope/stages/feature/thread`)).status).toBe(404);
  });
});

describe("POST .../stages/{stage}/thread", () => {
  it("a reply is written as the person's answer the next round reads, and shows in the thread", async () => {
    const r = await call("POST", `/api/changes/${CHANGE}/stages/stories/thread`, {
      kind: "reply",
      text: "Split the refusal into its own story.",
    });
    expect(r.status).toBe(200);
    const body = Api.StageThreadPostResult.parse(r.body);
    expect(body.files[1]).toBe(`${REL}/stage/stories.yaml`);
    const reply = body.thread.items.find((i) => i.kind === "reply");
    expect(reply).toMatchObject({
      text: "Split the refusal into its own story.",
      by: "priya",
      read: false,
    });
    const loop = await readFile(join(root, REL, "stage/stories.yaml"), "utf8");
    expect(loop).toContain(body.files[0]!.replace(/^questions\//, "").replace(/\.yaml$/, ""));
  });

  it("a reply about a finding is a comment on it", async () => {
    const r = await call("POST", `/api/changes/${CHANGE}/stages/stories/thread`, {
      kind: "finding",
      finding: "f-0000000a",
      gate: "plan",
      text: "Make the fix: add the story.",
    });
    expect(r.status).toBe(200);
    const body = Api.StageThreadPostResult.parse(r.body);
    expect(body.thread.items.some((i) => i.kind === "reply" && i.about === "f-0000000a")).toBe(
      true,
    );
  });

  it("Keep it anyway raises the dropped question, citing the nearest line", async () => {
    const r = await call("POST", `/api/changes/${CHANGE}/stages/stories/thread`, {
      kind: "keep",
      key: "0123456789ab",
    });
    expect(r.status).toBe(200);
    const body = Api.StageThreadPostResult.parse(r.body);
    expect(body.thread.items.some((i) => i.kind === "dropped")).toBe(false);
    const id = body.files[0]!.replace(/^questions\//, "").replace(/\.yaml$/, "");
    const q = await readQuestion(root, id);
    expect(q).toMatchObject({ state: "open", evidence: [`${REL}/brief.md:3`] });
    expect(body.thread.items.some((i) => i.kind === "question" && i.question.id === id)).toBe(true);
  });

  it("refuses an empty reply, and a reply before the stage ran", async () => {
    expect(
      (
        await call("POST", `/api/changes/${CHANGE}/stages/stories/thread`, {
          kind: "reply",
          text: " ",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/api/changes/${CHANGE}/stages/architecture/thread`, {
          kind: "reply",
          text: "x",
        })
      ).status,
    ).toBe(409);
  });
});

describe("the thread's pieces", () => {
  it("a lens run is the stage's whose draft came just before it", async () => {
    const all = await allRuns(root, CHANGE);
    expect(stageRuns(all, "stories").map((s) => s.run.runId)).toEqual([
      "run-20261109090000-0001",
      "run-20261109090500-0001",
      "run-20261109091000-0001",
    ]);
    expect(stageRuns(all, "feature")).toEqual([]);
    expect(stageStep("proposal", CHANGE)).toEqual(["change", "draft", CHANGE]);
    expect(stageStep("small", CHANGE)).toEqual(["change", "small", CHANGE]);
  });

  it("an answer's summary: what a YAML answer holds, else its first lines", () => {
    expect(answerSummary("```yaml\nflows:\n  - a\ndeploy: []\nwhy: short\n```\n")).toEqual([
      "flows: 1",
      "why: short",
    ]);
    expect(answerSummary("=== proposal.md\n# Proposal\n")).toEqual([
      "=== proposal.md",
      "# Proposal",
    ]);
  });
});
