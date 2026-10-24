import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_SPEC_TEMPLATE,
  listQuestions,
  parseRecord,
  questionsDirOf,
  raiseQuestions,
  reusedLine,
  differentThings,
  type QuestionJudge,
  SpecTemplate,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

/** ADR 0089: what the live dogfood runs of the repo specs showed. */

const flowWith = (patch: (f: Record<string, unknown>) => Record<string, unknown>) =>
  parseRecord(patch(structuredClone(EXAMPLES.Flow) as Record<string, unknown>));

describe("Flow text written as a bare YAML number or boolean (ADR 0089)", () => {
  it("reads then: 404, what: 200 and when: true as text", () => {
    const r = flowWith((f) => {
      const steps = f.steps as Record<string, unknown>[];
      steps[0] = { ...steps[0], what: 200 };
      return {
        ...f,
        trigger: { ...(f.trigger as object), what: 7 },
        errors: [
          { when: true, then: 404, evidence: (f.trigger as { evidence: unknown }).evidence },
        ],
      };
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.record.kind !== "Flow") return;
    expect(r.record.trigger.what).toBe("7");
    expect(r.record.steps[0]!.what).toBe("200");
    expect(r.record.errors[0]).toMatchObject({ when: "true", then: "404" });
  });

  it("loosens nothing else: an empty text, a list, an object, null and a numeric name are still refused", () => {
    const err = (v: unknown) =>
      flowWith((f) => ({
        ...f,
        errors: [{ when: "x", then: v, evidence: (f.trigger as { evidence: unknown }).evidence }],
      })).ok;
    expect(err("")).toBe(false);
    expect(err(["404"])).toBe(false);
    expect(err({ code: 404 })).toBe(false);
    expect(err(null)).toBe(false);
    expect(flowWith((f) => ({ ...f, name: 404 })).ok).toBe(false);
    expect(flowWith((f) => ({ ...f, component: 404 })).ok).toBe(false);
  });
});

describe("who calls an entry point (ADR 0089)", () => {
  it("keeps the caller and the route in on the trigger", () => {
    const r = flowWith((f) => ({
      ...f,
      trigger: {
        ...(f.trigger as object),
        caller: {
          who: "Northwind Pay",
          via: "the external API gateway",
          evidence: [
            { source: "code", repo: "forge-orders", path: "gateway/routes.yaml", line: 3 },
          ],
        },
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok && r.record.kind === "Flow")
      expect(r.record.trigger.caller).toMatchObject({
        who: "Northwind Pay",
        via: "the external API gateway",
      });
    expect(
      flowWith((f) => ({ ...f, trigger: { ...(f.trigger as object), caller: { via: "x" } } })).ok,
    ).toBe(false);
  });
});

describe("the default spec template asks for the steps a person draws (ADR 0089)", () => {
  it("says where a UI flow starts and ends, where an API flow starts and ends, every validation layer and every type crossing", () => {
    const why = (k: string) => DEFAULT_SPEC_TEMPLATE.triggers.find((t) => t.kind === k)!.why;
    expect(why("action")).toMatch(/person's action in the component or template/);
    expect(why("action")).toMatch(/navigate, refresh, show an error/);
    expect(why("endpoint")).toMatch(/who calls it/);
    expect(why("endpoint")).toMatch(/gateway/);
    expect(why("endpoint")).toMatch(/response or acknowledgement to that caller/);
    const step = (k: string) => DEFAULT_SPEC_TEMPLATE.steps.find((s) => s.kind === k)!.why;
    expect(step("validate")).toMatch(/the form, the request schema, the entity's constraints/);
    expect(step("transform")).toMatch(/a DTO to an entity, an entity to a DTO/);
  });

  it("gives a template the UI words by default, and lets an org pack list its own", () => {
    expect(DEFAULT_SPEC_TEMPLATE.ui.actionWords).toContain("submit");
    const own = SpecTemplate.parse({
      schemaVersion: 1,
      repoType: "forge-ui",
      version: 1,
      triggers: [{ kind: "action", why: "w" }],
      ui: { actionWords: ["x-act"] },
    });
    expect(own.ui.actionWords).toEqual(["x-act"]);
    expect(own.ui.endWords).toContain("navigate");
  });
});

const AT = "2026-10-21T12:00:00.000Z";
const by = (step: string) => ({
  step,
  repo: "forge-suite",
  command: `atticus ${step.replace("-", " ")} forge-suite`,
  rerun: `atticus ${step.replace("-", " ")} forge-suite`,
  at: AT,
});
const survey = {
  question:
    "Is forge-legacy, the old single-module project kept outside the Maven reactor, still part of the product, or should its /api/charts endpoints be left out?",
  options: [],
  evidence: ["pom.xml:16", "pom.xml:18"],
  scope: "repo" as const,
};
const verify = {
  question:
    "Is forge-legacy (the old chart service) still part of the forge-suite product, or a retired predecessor kept for reference?",
  options: [],
  evidence: ["forge-legacy/pom.xml:19", "pom.xml:22"],
  scope: "repo" as const,
};

/** The judge's recorded verdict for the pair (fixtures/judgments/same-question.yaml). */
const recordedSame: QuestionJudge = async (pairs) =>
  new Map(pairs.map((p) => [p.key, "same" as const]));

describe("the same question from two steps (ADR 0089, 0117)", () => {
  it("tells questions about different modules apart before any judge, and leaves the rest to it", () => {
    expect(
      differentThings(
        { question: "Is forge-legacy still part of the product?" },
        { question: "Is forge-admin still part of the product?" },
      ),
    ).toBeDefined();
    expect(differentThings(survey, verify, "forge-suite")).toBeUndefined();
  });

  it("reuses the open question another step asked, records the step on it, and says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-same-q-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const first = await raiseQuestions(root, [survey], by("scan-survey"));
    expect(first.raised).toHaveLength(1);
    const second = await raiseQuestions(
      root,
      [verify],
      { ...by("scan-verify"), run: "run-2" },
      { judge: recordedSame },
    );
    expect(second.raised).toEqual([]);
    expect(second.reused.map((q) => q.id)).toEqual([first.raised[0]!.id]);
    expect(second.known.map((q) => q.id)).toEqual([first.raised[0]!.id]);
    const file = parse(
      await readFile(join(questionsDirOf(root), `${first.raised[0]!.id}.yaml`), "utf8"),
    );
    expect(file.alsoAskedBy).toEqual([
      {
        step: "scan-verify",
        command: "atticus scan verify forge-suite",
        run: "run-2",
        at: AT,
        rerun: "atticus scan verify forge-suite",
      },
    ]);
    // The verify step reads it as its own, so it follows the answer.
    const mine = await listQuestions(root, { repo: "forge-suite", step: "scan-verify" });
    expect(mine.questions.map((q) => q.id)).toEqual([first.raised[0]!.id]);
    expect(reusedLine(second.reused[0]!)).toMatch(
      /^q-[0-9a-f]{12} was already asked by atticus scan survey forge-suite: .* This step waits on the same answer instead of asking again\.$/,
    );
    // Asked again by the same step, it isn't added twice; one file in all.
    const third = await raiseQuestions(root, [verify], by("scan-verify"), {
      judge: recordedSame,
    });
    expect(third.reused[0]!.alsoAskedBy).toHaveLength(1);
    expect((await listQuestions(root)).questions).toHaveLength(1);
  });

  it("still raises a new question from the same step, and a different question from another", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-same-q-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await raiseQuestions(root, [survey], by("scan-survey"));
    const same = await raiseQuestions(root, [verify], by("scan-survey"));
    expect(same.raised).toHaveLength(1);
    const other = await raiseQuestions(
      root,
      [{ ...verify, question: "Which queue does the nightly job read?", evidence: ["job.yaml:4"] }],
      by("scan-verify"),
    );
    expect(other.raised).toHaveLength(1);
    expect(other.reused).toEqual([]);
  });
});
