import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AnswerMatch,
  answerQuestion,
  hostQuestionText,
  hostRuleCovers,
  HOSTS_NONE,
  HOSTS_OUTSIDE_INTERNAL,
  HOSTS_STEP,
  migrateQuestions,
  Question,
  QUESTION_SCHEMA_VERSION,
  raiseQuestions,
  readQuestion,
  TARGETS_SPLIT_LABEL,
  TARGETS_STEP_ID,
} from "../src/index.js";

/**
 * Answer by rule (ADR 0153, Q2): a host pattern or a path prefix given with a target or hosts
 * answer, so one answer covers every call that matches. A hosts answer's rule goes into the
 * manifest, whose own matching (hosts with *, basePath) then answers every call.
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const AT = "2026-11-01T12:00:00.000Z";
const MANIFEST = ["org-pack", "profiles", "forge", "repos.manifest.yaml"];

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-rules-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const hostDraft = (host: string, line = 10) => ({
  question: hostQuestionText(host),
  options: [
    {
      label: "forge-customers",
      means: "forge-customers serves HTTP",
      changes: `${host} goes under hosts for forge-customers`,
    },
    { label: HOSTS_OUTSIDE_INTERNAL, means: "another team's", changes: "a system" },
    { label: HOSTS_NONE, means: "nothing", changes: "nothing is added" },
  ],
  evidence: [`src/app/limits.service.ts:${line}`],
  scope: "repo" as const,
});
const by = (step: string) => ({
  step,
  repo: "forge-web",
  command: "atticus scan",
  rerun: "atticus scan",
  at: AT,
});

async function ask(root: string, host: string, line?: number): Promise<Question> {
  return (await raiseQuestions(root, [hostDraft(host, line)], by(HOSTS_STEP))).raised[0]!;
}

const manifestRepo = async (root: string, id: string) =>
  (
    parse(await readFile(join(root, ...MANIFEST), "utf8")) as {
      repos: { id: string; hosts?: string[]; basePath?: string }[];
    }
  ).repos.find((r) => r.id === id)!;

describe("the rule an answer covers (ADR 0153)", () => {
  it("takes a host pattern or a path prefix, nothing else", () => {
    for (const ok of [
      "*.payments.forge.internal",
      "limits.forge.internal:8443",
      "/forge/limits/**",
      "/forge/limits",
    ])
      expect(AnswerMatch.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["/forge/limits/", "https://x.forge.internal", "Forge Limits", "/a//b"])
      expect(AnswerMatch.safeParse(bad).success, bad).toBe(false);
  });

  it("covers a host as the manifest matches it, port and all", () => {
    expect(hostRuleCovers("*.payments.forge.internal", "limits.payments.forge.internal")).toBe(
      true,
    );
    expect(hostRuleCovers("*.payments.forge.internal", "limits.ledger.forge.internal")).toBe(false);
    expect(hostRuleCovers("localhost", "localhost:9966")).toBe(true);
    expect(hostRuleCovers("localhost:9000", "localhost:9966")).toBe(false);
  });

  it("is question schema version 5 (ADR 0181), and older files read as they are", () => {
    expect(QUESTION_SCHEMA_VERSION).toBe(5);
    const old = Question.parse({
      schemaVersion: 2,
      id: "q-0123456789ab",
      askedBy: { step: HOSTS_STEP, command: "atticus scan", at: AT },
      repo: "forge-web",
      question: hostQuestionText("x.forge.internal"),
      evidence: ["a.ts:1"],
      scope: { level: "repo", id: "forge-web" },
      state: "answered",
      rerun: "atticus scan",
      answer: {
        text: "forge-customers",
        by: "pat",
        at: AT,
        scope: { level: "repo", id: "forge-web" },
      },
    });
    expect(old.schemaVersion).toBe(5);
    expect(old.answer!.match).toBeUndefined();
  });
});

describe("a hosts answer by rule (ADR 0153)", () => {
  it("writes the host pattern under the repo's hosts and retires the open questions it covers", async () => {
    const root = await metarepo();
    const q = await ask(root, "limits.payments.forge.internal", 10);
    const other = await ask(root, "fees.payments.forge.internal", 20);
    const elsewhere = await ask(root, "notes.ledger.forge.internal", 30);
    const r = await answerQuestion(root, q.id, {
      option: 1,
      match: "*.payments.forge.internal",
      by: "pat",
      at: AT,
    });
    expect(r.question.answer).toMatchObject({ option: 1, match: "*.payments.forge.internal" });
    expect(r.hosts).toMatchObject({
      repo: "forge-customers",
      host: "*.payments.forge.internal",
      added: true,
    });
    expect((await manifestRepo(root, "forge-customers")).hosts).toEqual([
      "*.payments.forge.internal",
    ]);
    expect(r.covered).toEqual([other.id]);
    const retired = (await readQuestion(root, other.id))!;
    expect(retired.state).toBe("retired");
    expect(retired.retired).toMatchObject({ replacedBy: [q.id] });
    expect((await readQuestion(root, elsewhere.id))!.state).toBe("open");
    const text = await readFile(join(root, "questions", `${q.id}.yaml`), "utf8");
    expect(text).toContain("schemaVersion: 5");
    expect(text).toContain('match: "*.payments.forge.internal"');
  });

  it("a path prefix sets the repo's basePath on the host", async () => {
    const root = await metarepo();
    const q = await ask(root, "api.forge.internal");
    const r = await answerQuestion(root, q.id, {
      option: 1,
      match: "/forge/limits/**",
      by: "pat",
      at: AT,
    });
    expect(r.hosts).toMatchObject({ host: "api.forge.internal", basePath: "/forge/limits" });
    const m = await manifestRepo(root, "forge-customers");
    expect(m.hosts).toEqual(["api.forge.internal"]);
    expect(m.basePath).toBe("/forge/limits");
  });

  it("refuses a pattern that doesn't cover the asked host, and leaves the question open", async () => {
    const root = await metarepo();
    const q = await ask(root, "limits.payments.forge.internal");
    await expect(
      answerQuestion(root, q.id, {
        option: 1,
        match: "*.ledger.forge.internal",
        by: "pat",
        at: AT,
      }),
    ).rejects.toThrow(/doesn't cover limits\.payments\.forge\.internal/);
    expect((await readQuestion(root, q.id))!.state).toBe("open");
  });

  it("refuses a rule on an outside system, none of these, or a match that isn't one", async () => {
    const root = await metarepo();
    const q = await ask(root, "limits.payments.forge.internal");
    for (const option of [2, 3])
      await expect(
        answerQuestion(root, q.id, {
          option,
          match: "*.payments.forge.internal",
          by: "pat",
          at: AT,
        }),
      ).rejects.toThrow(/names the repo that answers/);
    await expect(
      answerQuestion(root, q.id, { option: 1, match: "https://x", by: "pat", at: AT }),
    ).rejects.toThrow(/isn't a rule Atticus reads/);
  });

  it("refuses a rule on a question that isn't about where calls go", async () => {
    const root = await metarepo();
    const q = (
      await raiseQuestions(
        root,
        [
          {
            question: "Is docs/ generated?",
            options: [],
            evidence: ["docs/a.js:1"],
            scope: "repo",
          },
        ],
        by("scan-survey"),
      )
    ).raised[0]!;
    await expect(
      answerQuestion(root, q.id, { text: "yes", match: "/docs/**", by: "pat", at: AT }),
    ).rejects.toThrow(/Only a question about where calls go/);
  });
});

describe("a target answer by rule (ADR 0153)", () => {
  const targetDraft = {
    question: "Which repo or system answers the calls forge-web makes under /forge?",
    options: [
      { label: "forge-customers", means: "it answers", changes: "the calls join it" },
      { label: TARGETS_SPLIT_LABEL, means: "not one place", changes: "asked one by one" },
    ],
    evidence: ["src/app/limits.service.ts:10"],
    scope: "repo" as const,
  };

  it("keeps the rule with the answer, at the scope confirmed", async () => {
    const root = await metarepo();
    const q = (await raiseQuestions(root, [targetDraft], by(TARGETS_STEP_ID))).raised[0]!;
    const r = await answerQuestion(root, q.id, {
      option: 1,
      match: "/forge/limits/**",
      scope: "repo-type",
      repoType: "spa",
      by: "pat",
      at: AT,
    });
    expect(r.question.answer).toMatchObject({
      match: "/forge/limits/**",
      scope: { level: "repo-type", id: "spa" },
    });
  });

  it("refuses a rule on 'Not all to one place'", async () => {
    const root = await metarepo();
    const q = (await raiseQuestions(root, [targetDraft], by(TARGETS_STEP_ID))).raised[0]!;
    await expect(
      answerQuestion(root, q.id, { option: 2, match: "/forge/**", by: "pat", at: AT }),
    ).rejects.toThrow(/no rule rides on it/);
  });
});

describe("atticus upgrade: questions at version 5 (ADR 0153, ADR 0162, ADR 0181)", () => {
  it("rewrites version 1, 2 and 3 files at version 5, and nothing else changes", async () => {
    const root = await metarepo();
    const q = await ask(root, "limits.payments.forge.internal");
    const file = join(root, "questions", `${q.id}.yaml`);
    const v2 = (await readFile(file, "utf8")).replace("schemaVersion: 5", "schemaVersion: 2");
    await writeFile(file, v2);
    await mkdir(join(root, "questions"), { recursive: true });
    expect(await migrateQuestions(root, { dryRun: true })).toEqual([`questions/${q.id}.yaml`]);
    expect(await readFile(file, "utf8")).toBe(v2);
    expect(await migrateQuestions(root)).toEqual([`questions/${q.id}.yaml`]);
    expect(await readFile(file, "utf8")).toBe(v2.replace("schemaVersion: 2", "schemaVersion: 5"));
    expect(await migrateQuestions(root)).toEqual([]);
    const v3 = v2.replace("schemaVersion: 2", "schemaVersion: 3");
    await writeFile(file, v3);
    expect(await migrateQuestions(root)).toEqual([`questions/${q.id}.yaml`]);
    expect(await readFile(file, "utf8")).toBe(v2.replace("schemaVersion: 2", "schemaVersion: 5"));
  });
});
