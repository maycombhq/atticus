import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { Api, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";
import {
  countByRole,
  isChangeQuestion,
  personsRoles,
  stageQuestions,
} from "../src/change-roles.js";

/**
 * ADR 0181 part 4: each role answers its own questions. The questions API says each question's
 * role, filters by role and by change, counts by role, and says the signed-in person's roles on the
 * change from its change.yaml `owners`. Invented Forge names; files only, no network.
 */

const AT = "2026-11-08T10:00:00.000Z";
const CHANGE = "add-holds";

let root: string;
let srv: RunningServer;
const ids = { feature: "", architecture: "", stories: "", survey: "" };

const call = async (path: string) => {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const draft = (question: string, evidence: string) =>
  QuestionDraft.parse({ question, evidence: [evidence] });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-question-roles-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/roles.yaml"),
    stringify({
      schemaVersion: 2,
      custom: [{ id: "solution-designer", name: "Solution designer", basedOn: "architect" }],
    }),
  );
  const dir = join(root, "openspec/changes", CHANGE);
  await mkdir(join(dir, "stage"), { recursive: true });
  await writeFile(
    join(dir, "change.yaml"),
    stringify({
      schemaVersion: 1,
      id: CHANGE,
      title: "Holds on ledger accounts",
      type: "feature",
      state: "design",
      owners: {
        "product-owner": ["pat"],
        "solution-designer": ["priya.nair"],
        "team-lead": ["@Priya.Nair", "sam"],
      },
      createdAt: AT,
      createdBy: "pat",
    }),
  );
  // The feature stage files its question under the change. The stage is the architect's (it
  // places the change on the estate, ninth UX walk); this one asks the product owner what the
  // brief meant, so it says so.
  const feature = await raiseQuestions(
    root,
    [
      {
        ...draft("Who may place a hold?", `openspec/changes/${CHANGE}/proposal.md:3`),
        role: "product",
      },
    ],
    {
      step: "change-feature",
      repo: CHANGE,
      command: `atticus change feature ${CHANGE}`,
      rerun: `atticus change feature ${CHANGE}`,
      at: AT,
    },
  );
  ids.feature = feature.raised[0]!.id;
  // The architecture stage files its question under the repo it is about; its loop file lists it.
  const arch = await raiseQuestions(
    root,
    [draft("Does forge-ledger own the holds table?", "src/holds.ts:12")],
    {
      step: "change-architecture",
      repo: "forge-ledger",
      command: `atticus change architecture ${CHANGE}`,
      rerun: `atticus change architecture ${CHANGE}`,
      at: AT,
    },
  );
  ids.architecture = arch.raised[0]!.id;
  await writeFile(
    join(dir, "stage/architecture.yaml"),
    stringify({ state: "waiting", questions: [ids.architecture] }),
  );
  // A version-4 file of the stories stage, written before roles: its role is derived on read.
  ids.stories = "q-0a0b0c0d0e0f";
  await mkdir(join(root, "questions"), { recursive: true });
  await writeFile(
    join(root, "questions", `${ids.stories}.yaml`),
    stringify({
      schemaVersion: 4,
      id: ids.stories,
      askedBy: { step: "change-stories", command: `atticus plan stories ${CHANGE}`, at: AT },
      repo: CHANGE,
      question: "Does a hold expire on its own?",
      evidence: [`openspec/changes/${CHANGE}/stories.md:5`],
      scope: { level: "repo", id: CHANGE },
      state: "open",
      rerun: `atticus plan stories ${CHANGE}`,
    }),
  );
  // A repo's own question, no change's: no role.
  const survey = await raiseQuestions(root, [draft("Is docs/ generated?", "docs/a.js:1")], {
    step: "scan-survey",
    repo: "forge-notes",
    command: "atticus scan survey forge-notes",
    rerun: "atticus scan survey forge-notes --force",
    at: AT,
  });
  ids.survey = survey.raised[0]!.id;
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) => uiQuestionRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("role-owned questions in the questions API (ADR 0181 part 4)", () => {
  it("says each question's role: written when raised, derived for an older file, none for a repo's", async () => {
    const all = Api.QuestionList.parse((await call("/api/questions")).body);
    expect(all.questions.find((q) => q.id === ids.feature)?.role).toBe("product");
    expect(all.about?.[ids.feature]?.role).toBe("product");
    expect(all.about?.[ids.architecture]?.role).toBe("architecture");
    expect(all.about?.[ids.stories]?.role).toBe("analysis");
    expect(all.about?.[ids.survey]).not.toHaveProperty("role");
    expect(all.counts?.byRole).toEqual({
      product: { open: 1, answered: 0, retired: 0, total: 1 },
      architecture: { open: 1, answered: 0, retired: 0, total: 1 },
      analysis: { open: 1, answered: 0, retired: 0, total: 1 },
    });
  });

  it("keeps a change's questions, wherever they are filed, and says the person's roles on it", async () => {
    const c = Api.QuestionList.parse((await call(`/api/questions?change=${CHANGE}`)).body);
    expect(c.questions.map((q) => q.id).sort()).toEqual(
      [ids.feature, ids.architecture, ids.stories].sort(),
    );
    // The custom role is based on the architect; a handle matches with @ and in any case.
    expect(c.yourRoles).toEqual(["architecture", "delivery"]);
    expect(c.counts?.total).toBe(3);
  });

  it("keeps one role's questions with role=, and refuses a role that isn't one", async () => {
    const r = Api.QuestionList.parse(
      (await call(`/api/questions?change=${CHANGE}&role=architecture`)).body,
    );
    expect(r.questions.map((q) => q.id)).toEqual([ids.architecture]);
    // The counts are the change's, whatever role was listed, so a page can show each role's.
    expect(r.counts?.byRole?.product?.open).toBe(1);
    // Review round 46: the other counts are the role's, as the list is.
    expect(r.counts).toMatchObject({ open: 1, answered: 0, retired: 0, total: 1 });
    expect(Object.keys(r.counts?.byRepo ?? {})).toEqual(["forge-ledger"]);
    const all = Api.QuestionList.parse((await call("/api/questions?role=analysis")).body);
    expect(all.questions.map((q) => q.id)).toEqual([ids.stories]);
    expect((await call("/api/questions?role=developer")).status).toBe(400);
    expect((await call("/api/questions?change=No%20Such")).status).toBe(400);
  });

  it("says no roles for a person the change doesn't name", async () => {
    expect(await personsRoles(root, CHANGE, "cy")).toEqual([]);
    expect(await personsRoles(root, CHANGE, undefined)).toEqual([]);
    expect(await personsRoles(root, "no-such-change", "pat")).toEqual([]);
    expect(await personsRoles(root, CHANGE, "pat")).toEqual(["product"]);
  });

  it("ties a stage's question to its change by the stage's loop file", async () => {
    const stages = await stageQuestions(root);
    expect(stages.get(ids.architecture)).toEqual({ change: CHANGE, role: "architecture" });
    const all = Api.QuestionList.parse((await call("/api/questions")).body).questions;
    const arch = all.find((q) => q.id === ids.architecture)!;
    expect(isChangeQuestion(arch, CHANGE, { stages })).toBe(true);
    expect(isChangeQuestion(arch, "another-change", { stages })).toBe(false);
    expect(countByRole(all, (q) => q.role)).toEqual({
      product: { open: 1, answered: 0, retired: 0, total: 1 },
      architecture: { open: 1, answered: 0, retired: 0, total: 1 },
    });
  });
});
