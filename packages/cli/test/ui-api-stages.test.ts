import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  Api,
  Finding,
  QuestionDraft,
  raiseQuestions,
  readQuestion,
  REVIEW_SCHEMA_VERSION,
} from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiStageRoutes } from "../src/ui-api-stages.js";

/**
 * A stage tab's findings with their options and a comment box (ADR 0124 addendum D-app, B10):
 * GET /api/changes/{id}/stages/{stage} gives the latest round of the stage's gate with what each
 * finding allows and the comments on it, the stage's own questions and its command; POST
 * .../comments writes a comment as a question the person answered, listed in the stage's loop
 * file. On the Forge metarepo, whose gates are design, plan, build and release.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;
const NOW = new Date("2026-10-24T10:00:00Z");
const PERSON = "Priya Nair <priya@forge.example>";

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

const finding = (o: Partial<Finding> & Pick<Finding, "id" | "severity" | "kind">): Finding =>
  Finding.parse({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    change: CHANGE,
    gate: "plan",
    round: 2,
    rule: "review.outcome-has-story",
    layer: "org",
    lens: "complete",
    artifact: "stories.md",
    locator: { line: 4 },
    summary: "The refusal outcome has no story.",
    why: "Every outcome the brief names needs a story that builds it.",
    fix: { text: "Add a story for refusing a transfer over the limit." },
    evidence: [{ source: "artifact", path: "stories.md", line: 4, quote: "## Stories" }],
    waivable: false,
    createdAt: "2026-10-24T09:00:00Z",
    ...o,
  });

async function file(path: string, f: Finding) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), stringify(f));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-stages-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  // The plan gate reviewed twice; only the latest round is the stage tab's.
  await file(
    `${REL}/review/plan/1/f-00000001.yaml`,
    finding({ id: "f-00000001", round: 1, severity: "risk", kind: "issue" }),
  );
  await file(
    `${REL}/review/plan/2/f-0000000a.yaml`,
    finding({ id: "f-0000000a", severity: "blocking", kind: "issue", waivable: true }),
  );
  await file(
    `${REL}/review/plan/2/f-0000000b.yaml`,
    finding({
      id: "f-0000000b",
      severity: "blocking",
      kind: "issue",
      layer: "constitution",
      rule: "constitution.public-entry-auth",
      summary: "The limits entry names no auth.",
    }),
  );
  await file(
    `${REL}/review/plan/2/f-0000000c.yaml`,
    finding({
      id: "f-0000000c",
      severity: "gap",
      kind: "knowledge-gap",
      rule: "review.slo-known",
      summary: "No SLO is known for the ledger.",
      question: { text: "What is the ledger's latency SLO?", owner: "ledger-team" },
    }),
  );
  // The design gate's finding belongs to the Architecture tab, not the Stories tab.
  await file(
    `${REL}/review/design/1/f-0000000d.yaml`,
    finding({ id: "f-0000000d", gate: "design", round: 1, severity: "risk", kind: "issue" }),
  );
  // The stories stage has run: its loop file, with a question it raised for a person.
  const q = await raiseQuestions(
    root,
    [
      QuestionDraft.parse({
        question: "Does the daily limit reset at midnight UTC or the customer's midnight?",
        evidence: [`${REL}/stories.md:1`],
      }),
    ],
    {
      step: "change-stories",
      repo: CHANGE,
      command: `atticus plan stories ${CHANGE}`,
      rerun: `atticus plan stories ${CHANGE}`,
      at: NOW.toISOString(),
    },
  );
  await mkdir(join(root, REL, "stage"), { recursive: true });
  await writeFile(
    join(root, REL, "stage/stories.yaml"),
    stringify({
      schemaVersion: 1,
      change: CHANGE,
      stage: "stories",
      iteration: 2,
      state: "questions",
      updatedAt: NOW.toISOString(),
      questions: [q.raised[0]!.id],
    }),
  );
  srv = await startServer({
    root,
    port: 0,
    user: PERSON,
    extend: (r, ctx) => uiStageRoutes(r, ctx, { now: () => NOW }),
  });
});
afterAll(() => srv?.close());

describe("a stage tab's findings", () => {
  it("gives the latest round of the stage's gate, each finding with the options it allows, and the stage's questions", async () => {
    const r = await call("GET", `/api/changes/${CHANGE}/stages/stories`);
    expect(r.status).toBe(200);
    const v = Api.StageReviewView.parse(r.body);
    expect(v).toMatchObject({
      change: CHANGE,
      stage: "stories",
      gate: "plan",
      round: 2,
      loop: { file: `${REL}/stage/stories.yaml`, present: true, state: "questions", iteration: 2 },
      next: { command: `atticus plan stories ${CHANGE}`, slash: `/atticus-stories ${CHANGE}` },
      problems: [],
    });
    expect(v.findings.map((f) => f.finding.id)).toEqual(["f-0000000a", "f-0000000b", "f-0000000c"]);
    const [waivable, constitution, gap] = v.findings;
    expect(waivable!.file).toBe(`${REL}/review/plan/2/f-0000000a.yaml`);
    expect(waivable!.options).toEqual({
      fix: "Add a story for refusing a transfer over the limit.",
      apply: true,
      dismiss: true,
      waive: true,
    });
    // A constitution rule is never waived; a knowledge gap is asked of its owner.
    expect(constitution!.options.waive).toBe(false);
    expect(gap!.options).toMatchObject({
      apply: false,
      dismiss: false,
      waive: false,
      ask: { text: "What is the ledger's latency SLO?", owner: "ledger-team" },
    });
    expect(v.questions.map((q) => [q.question, q.state])).toEqual([
      ["Does the daily limit reset at midnight UTC or the customer's midnight?", "open"],
    ]);
  });

  it("finds the Architecture tab's findings at the design gate, and none for a stage whose phase has no gate", async () => {
    const a = Api.StageReviewView.parse(
      (await call("GET", `/api/changes/${CHANGE}/stages/architecture`)).body,
    );
    expect(a).toMatchObject({ gate: "design", round: 1, loop: { present: false } });
    expect(a.findings.map((f) => f.finding.id)).toEqual(["f-0000000d"]);
    const f = Api.StageReviewView.parse(
      (await call("GET", `/api/changes/${CHANGE}/stages/feature`)).body,
    );
    expect(f).toMatchObject({ gate: null, round: null, findings: [], questions: [] });
    expect(f.next.command).toBe(`atticus change feature ${CHANGE}`);
  });

  it("refuses a stage that isn't one, and a change that isn't there", async () => {
    expect((await call("GET", `/api/changes/${CHANGE}/stages/tasks`)).status).toBe(400);
    expect((await call("GET", "/api/changes/no-such-change/stages/stories")).status).toBe(404);
  });
});

describe("a comment on a finding", () => {
  it("is written as the person's answered question, listed in the loop file, with the git and stage commands", async () => {
    const r = await call("POST", `/api/changes/${CHANGE}/stages/stories/comments`, {
      finding: "f-0000000a",
      text: "The refusal is s1's second criterion; add it as its own story only if the PO wants one.",
    });
    expect(r.status).toBe(200);
    const res = Api.StageCommentResult.parse(r.body);
    const id = res.comment.question;
    expect(res).toMatchObject({
      comment: { by: PERSON, at: NOW.toISOString(), read: false },
      files: [`questions/${id}.yaml`, `${REL}/stage/stories.yaml`],
      commit: `git add questions/${id}.yaml ${REL}/stage/stories.yaml && git commit -m "${CHANGE}: a comment on f-0000000a"`,
      next: { command: `atticus plan stories ${CHANGE}`, slash: `/atticus-stories ${CHANGE}` },
    });
    const q = (await readQuestion(root, id))!;
    expect(q.state).toBe("answered");
    expect(q.evidence).toEqual([`${REL}/review/plan/2/f-0000000a.yaml:1`]);
    const loop = parse(await readFile(join(root, REL, "stage/stories.yaml"), "utf8"));
    expect(loop.questions).toContain(id);
    // The tab shows it under its finding, not among the stage's questions.
    const v = Api.StageReviewView.parse(
      (await call("GET", `/api/changes/${CHANGE}/stages/stories`)).body,
    );
    expect(v.findings[0]!.comments).toEqual([res.comment]);
    expect(v.questions).toHaveLength(1);
  });

  it("is refused for a finding not in the tab, an empty comment, and a stage that hasn't run", async () => {
    const post = (stage: string, body: unknown) =>
      call("POST", `/api/changes/${CHANGE}/stages/${stage}/comments`, body);
    expect((await post("stories", { finding: "f-0000000d", text: "x" })).status).toBe(404);
    expect((await post("stories", { finding: "f-0000000a", text: "  " })).status).toBe(400);
    const notRun = await post("architecture", { finding: "f-0000000d", text: "Use the gateway." });
    expect(notRun.status).toBe(409);
    expect(JSON.stringify(notRun.body)).toContain(
      `run atticus change architecture ${CHANGE} first`,
    );
  });
});
