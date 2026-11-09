import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  aiPause,
  AiBy,
  answerByWords,
  BatchId,
  correctionLine,
  decideOf,
  DecisionBatch,
  deriveMatch,
  Evidence,
  FactCorrection,
  FACT_CORRECTIONS_SCHEMA_VERSION,
  isAiBy,
  joinFacts,
  joinFlagsOf,
  joinRecords,
  JOINED_BY_AI,
  JOIN_GUESS_FLAGS,
  JOIN_HOW_FLAGS,
  linkCandidates,
  matchCovers,
  migrateRuntimeV4Text,
  NO_TARGET,
  newBatchId,
  pairingBar,
  pairsFromCorrections,
  parseCorrections,
  parseFacts,
  Question,
  QUESTION_SCHEMA_VERSION,
  questionAiProblem,
  questionBar,
  Runtime,
  RUNTIME_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  auditPrecision,
  type AuditItemT,
  type CandidateApi,
} from "../src/index.js";

/**
 * ADR 0181: AI decides first, as itself; a person corrects one and the correction spreads.
 * Forge: forge-refunds calls the gateway proxy forge-gw; Copilot pairs the loose calls and answers
 * an option question, and Atticus records each decision as the AI's, with its run, never as a
 * person's.
 */

const call = (id: string, path: string, line: number, method = "POST") =>
  JSON.stringify({
    kind: "call",
    id,
    repo: "forge-refunds",
    commit: "1111aaa",
    callType: "rest",
    method,
    path,
    base: "forge.gw.base",
    cite: { file: "src/main/java/forge/refunds/GwClient.java", line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const route = (id: string, path: string, line: number, method = "POST") =>
  JSON.stringify({
    kind: "entry",
    id,
    repo: "forge-gw",
    commit: "2222bbb",
    component: "forge-gw",
    entryType: "rest",
    method,
    path,
    cite: { file: "apiproxy/proxies/default.xml", line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const refunds = parseFacts(
  [
    call("c-request-refund", "requestRefundPath", 21),
    call("c-status", "/payments/{id}/status", 40, "GET"),
  ].join("\n"),
);
const gw = parseFacts(
  [
    route("e-refunds-request", "/v2/refunds/request", 10),
    route("e-payments-status", "/v2/payments/{paymentId}/status", 30, "GET"),
  ].join("\n"),
);
if (!refunds.ok || !gw.ok) throw new Error("fixture facts don't parse");
const repos = [
  { repo: "forge-refunds", facts: refunds.facts },
  { repo: "forge-gw", facts: gw.facts },
];
const apis: CandidateApi[] = gw.facts.map((f) => ({
  id: f.id,
  kind: "route",
  ...(f.kind === "entry" && f.method ? { method: f.method } : {}),
  path: (f as { path: string }).path,
}));

const ai = { kind: "ai", runtime: "copilot-acp", run: "20261108-101500-ab12" } as const;
const target = {
  kind: "call" as const,
  file: "src/main/java/forge/refunds/GwClient.java",
  line: 21,
  value: "requestRefundPath",
};

const question = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 4,
  id: "q-0123456789ab",
  askedBy: {
    step: "facts-targets",
    command: "atticus verify forge-refunds --write",
    at: "2026-11-08T09:00:00Z",
  },
  repo: "forge-refunds",
  question: "Where does forge-refunds's call POST /forge/refunds/request go?",
  options: [
    { label: "forge-gw", means: "forge-gw: the same path", changes: "The call joins forge-gw" },
    { label: "Another repo…", means: "A repo not listed", changes: "Nothing until you name one" },
    { label: "None of these", means: "Nothing answers it", changes: "The call stays loose" },
  ],
  evidence: ["src/main/java/forge/refunds/GwClient.java:21"],
  scope: { level: "repo", id: "forge-refunds" },
  state: "open",
  rerun: "atticus verify forge-refunds --write",
  ...over,
});

describe("C6 question file version 5: an answer by AI, beside a person's (ADR 0181)", () => {
  it("is version 6 (ADR 0189), and reads a version 4 file unchanged, as version 6 in memory", () => {
    expect(QUESTION_SCHEMA_VERSION).toBe(6);
    const q = Question.parse(
      question({
        state: "answered",
        answer: {
          option: 1,
          by: "pat",
          at: "2026-11-08T09:30:00Z",
          scope: { level: "repo", id: "forge-refunds" },
        },
      }),
    );
    expect(q.schemaVersion).toBe(6);
    expect(q.answer!.by).toBe("pat");
    expect(isAiBy(q.answer!.by)).toBe(false);
  });

  it("takes by: { kind: ai, runtime, run } with a batch, and says it as the AI's, never a person's", () => {
    const q = Question.parse(
      question({
        schemaVersion: 5,
        state: "answered",
        answer: {
          option: 1,
          by: { ...ai, bar: "agrees-with-shapes" },
          at: "2026-11-08T10:15:00Z",
          scope: { level: "repo", id: "forge-refunds" },
          batch: "b-20261108-101500-a1b2c3",
        },
      }),
    );
    expect(isAiBy(q.answer!.by)).toBe(true);
    expect(answerByWords(q.answer!.by)).toBe("AI (copilot-acp, run 20261108-101500-ab12)");
    expect(answerByWords("pat")).toBe("pat");
  });

  it("refuses an AI answer in words, at a repo type's scope, or with a rule of its own", () => {
    const bad = (answer: Record<string, unknown>) =>
      Question.safeParse(
        question({
          schemaVersion: 5,
          state: "answered",
          answer: {
            by: ai,
            at: "2026-11-08T10:15:00Z",
            scope: { level: "repo", id: "forge-refunds" },
            ...answer,
          },
        }),
      ).success;
    expect(bad({ option: 1 })).toBe(true);
    expect(bad({ text: "forge-gw" })).toBe(false);
    expect(bad({ option: 1, scope: { level: "repo-type", id: "service" } })).toBe(false);
    expect(bad({ option: 1, match: "/forge/refunds/**" })).toBe(false);
    // Ninth UX walk: a hand-off run Atticus recorded is one (its Done reads the answer back);
    // a runtime Atticus records no run of is no AI answer.
    expect(AiBy.safeParse({ ...ai, runtime: "hand-off" }).success).toBe(true);
    expect(AiBy.safeParse({ ...ai, runtime: "model" }).success).toBe(false);
  });

  it("records an answer applied by a person's rule: theirs, with the correction it came from", () => {
    const q = Question.parse(
      question({
        schemaVersion: 5,
        state: "answered",
        answer: {
          option: 1,
          by: "pat",
          at: "2026-11-08T11:00:00Z",
          scope: { level: "repo", id: "forge-refunds" },
          batch: "b-20261108-110000-0f0f0f",
          rule: { from: "q-aaaaaaaaaaaa", match: "/forge/refunds/**" },
        },
      }),
    );
    expect(q.answer!.rule).toEqual({ from: "q-aaaaaaaaaaaa", match: "/forge/refunds/**" });
  });
});

describe("C1: a pairing by AI is a link line of its own, flagged joined-by-ai with its run", () => {
  it("is corrections version 2; version 1 lines read unchanged", () => {
    expect(FACT_CORRECTIONS_SCHEMA_VERSION).toBe(2);
    const v1 = {
      schemaVersion: 1,
      fact: "c-request-refund",
      target,
      action: "link",
      link: {
        repo: "forge-gw",
        entry: "e-refunds-request",
        method: "POST",
        path: "/v2/refunds/request",
      },
      by: "pat",
      at: "2026-11-06T10:00:00.000Z",
    };
    expect(FactCorrection.parse(v1).schemaVersion).toBe(1);
    expect(parseCorrections(JSON.stringify(v1)).bad).toEqual([]);
  });

  it("takes an AI line only as Atticus's, at version 2, linking a repo's entry", () => {
    const line = {
      schemaVersion: 2,
      fact: "c-request-refund",
      target,
      action: "link",
      link: {
        repo: "forge-gw",
        entry: "e-refunds-request",
        method: "POST",
        path: "/v2/refunds/request",
      },
      by: "atticus",
      ai: { runtime: "copilot-acp", run: ai.run, bar: "agrees-with-shapes" },
      batch: "b-20261108-101500-a1b2c3",
      at: "2026-11-08T10:15:00.000Z",
    };
    expect(FactCorrection.safeParse(line).success).toBe(true);
    expect(correctionLine(FactCorrection.parse(line))).toContain('"ai":{');
    expect(FactCorrection.safeParse({ ...line, schemaVersion: 1 }).success).toBe(false);
    expect(FactCorrection.safeParse({ ...line, by: "pat" }).success).toBe(false);
    expect(
      FactCorrection.safeParse({ ...line, link: { system: "northwind-pay", path: "/charges" } })
        .success,
    ).toBe(false);
    expect(
      FactCorrection.safeParse({ ...line, action: "wrong", link: undefined, reason: "x" }).success,
    ).toBe(false);
  });

  it("takes a person's unlink: the call reaches none of these, which withdraws a pairing", () => {
    const pair = FactCorrection.parse({
      schemaVersion: 2,
      fact: "c-request-refund",
      target,
      action: "link",
      link: { repo: "forge-gw", entry: "e-refunds-request", path: "/v2/refunds/request" },
      by: "atticus",
      ai: { runtime: "copilot-acp", run: ai.run },
      at: "2026-11-08T10:15:00.000Z",
    });
    const none = FactCorrection.parse({
      schemaVersion: 2,
      fact: "c-request-refund",
      target,
      action: "unlink",
      by: "pat",
      match: "/forge/refunds/**",
      at: "2026-11-08T11:00:00.000Z",
    });
    expect(pairsFromCorrections(refunds.facts, [pair])).toEqual({
      "c-request-refund": {
        repo: "forge-gw",
        entry: "e-refunds-request",
        path: "/v2/refunds/request",
        by: "atticus",
        ai: { runtime: "copilot-acp", run: ai.run },
      },
    });
    expect(pairsFromCorrections(refunds.facts, [pair, none])).toEqual({});
    expect(
      FactCorrection.safeParse({ ...none, link: { repo: "forge-gw", path: "/x" } }).success,
    ).toBe(false);
  });

  it("joins an AI pairing flagged joined-by-ai, inferred, with evidence of source ai and the run", () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(5);
    expect(JOIN_HOW_FLAGS.has(JOINED_BY_AI)).toBe(true);
    expect((JOIN_GUESS_FLAGS as readonly string[]).includes(JOINED_BY_AI)).toBe(false);
    const join = joinFacts({
      repos,
      pairs: {
        "forge-refunds": {
          "c-request-refund": {
            repo: "forge-gw",
            entry: "e-refunds-request",
            path: "/v2/refunds/request",
            by: "atticus",
            ai: { runtime: "copilot-acp", run: ai.run },
          },
        },
      },
    });
    const j = join.joins.find((x) => x.call.fact === "c-request-refund")!;
    expect(j.paired).toEqual({ by: "atticus", ai: { runtime: "copilot-acp", run: ai.run } });
    expect(joinFlagsOf(j)).toEqual([JOINED_BY_AI]);
    const recs = joinRecords(join, repos) as unknown as {
      kind: string;
      confidence: string;
      flags?: string[];
      evidence: Record<string, unknown>[];
    }[];
    const r = recs.find((x) => x.kind === "Interface" && x.flags?.includes(JOINED_BY_AI))!;
    expect(r.confidence).toBe("inferred");
    expect(r.flags).not.toContain("joined-by-person");
    expect(r.evidence).toContainEqual(
      expect.objectContaining({ source: "ai", by: "copilot-acp", run: ai.run }),
    );
    expect(Evidence.safeParse({ source: "ai", by: "copilot-acp", run: ai.run }).success).toBe(true);
  });

  it("joins a call whose target an AI answer named flagged joined-by-ai, not joined-by-answer", () => {
    const join = joinFacts({
      repos,
      targets: { "forge-refunds": { "c-status": "forge-gw" } },
      aiTargets: { "forge-refunds": { "c-status": { runtime: "copilot-acp", run: ai.run } } },
    });
    const j = join.joins.find((x) => x.call.fact === "c-status")!;
    expect(j.how).toBe("answer");
    expect(joinFlagsOf(j)).toEqual([JOINED_BY_AI]);
    const recs = joinRecords(join, repos) as unknown as { kind: string; flags?: string[] }[];
    for (const r of recs.filter((x) => x.kind === "Interface"))
      expect(r.flags ?? []).not.toContain("joined-by-answer");
  });
});

describe("C6 runtime.yaml version 4: decide (ADR 0181)", () => {
  const base = { assistants: { allowed: ["copilot"], default: "copilot" } };
  it("defaults to propose for links and questions, with a bar of 0.95", () => {
    expect(RUNTIME_SCHEMA_VERSION).toBe(4);
    const r = Runtime.parse({ schemaVersion: 3, ...base });
    expect(decideOf(r)).toEqual({ links: "propose", questions: "propose", minPrecision: 0.95 });
  });
  it("takes decide in version 4 only, and the upgrade writes the number only", () => {
    const decide = { links: "auto", questions: "auto", minPrecision: 0.9 };
    const v3 = Runtime.safeParse({ schemaVersion: 3, ...base, decide });
    expect(JSON.stringify(v3.error?.issues)).toMatch(
      /decide needs schemaVersion 4 \(ADR 0181\): run atticus upgrade/,
    );
    expect(decideOf(Runtime.parse({ schemaVersion: 4, ...base, decide }))).toEqual(decide);
    expect(
      Runtime.safeParse({ schemaVersion: 4, ...base, decide: { minPrecision: 1.5 } }).success,
    ).toBe(false);
    const text = [
      "# Forge runtime",
      "schemaVersion: 3",
      "assistants: { allowed: [copilot], default: copilot }",
      "decide: { links: auto }",
      "",
    ].join("\n");
    const m = migrateRuntimeV4Text(text);
    expect(m).toEqual({
      text: text.replace("schemaVersion: 3", "schemaVersion: 4"),
      changed: true,
    });
    expect(parse(m.text).decide).toEqual({ links: "auto" });
    // A file without decide means the same at 3: left as it is.
    expect(migrateRuntimeV4Text(text.replace("decide: { links: auto }\n", "")).changed).toBe(false);
  });
});

describe("when the AI's decision is applied (ADR 0181, part 1)", () => {
  const cands = linkCandidates({
    from: "forge-refunds",
    facts: refunds.facts,
    join: joinFacts({ repos }),
    apis,
    pairs: {},
    to: { repo: "forge-gw" },
  });
  const byFact = Object.fromEntries(cands.calls.map((c) => [c.fact, c]));

  it("applies a pairing the shapes call confident, or whose best shape it agrees with", () => {
    expect(pairingBar(byFact["c-status"]!, "e-payments-status")).toBe("confident");
    expect(pairingBar(byFact["c-request-refund"]!, "e-refunds-request")).toBe("agrees-with-shapes");
    // The AI picked what the shapes don't: a proposal, as today.
    expect(pairingBar(byFact["c-status"]!, "e-refunds-request")).toBeUndefined();
    // Unless it agrees with a person's rule.
    expect(pairingBar(byFact["c-status"]!, "e-refunds-request", { ruleAgrees: true })).toBe(
      "person-rule",
    );
  });

  it("decides only an option question about a target on file, at the repo's scope", () => {
    const q = Question.parse(question());
    expect(questionAiProblem(q, 1)).toBeUndefined();
    expect(questionAiProblem(q, 2)).toMatch(/names nothing/);
    expect(questionAiProblem(q, 3)).toMatch(/none/i);
    expect(questionAiProblem(Question.parse(question({ options: [] })), 1)).toMatch(
      /free-text|words/,
    );
    expect(
      questionAiProblem(
        Question.parse(question({ scope: { level: "repo-type", id: "service" } })),
        1,
      ),
    ).toMatch(/wider than the repo/);
    expect(
      questionAiProblem(
        Question.parse(
          question({ askedBy: { step: "scan-hosts", command: "x", at: "2026-11-08T09:00:00Z" } }),
        ),
        1,
      ),
    ).toMatch(/manifest|org pack/);
    expect(
      questionAiProblem(
        Question.parse(
          question({ state: "retired", retired: { at: "2026-11-08T09:00:00Z", why: "x" } }),
        ),
        1,
      ),
    ).toMatch(/open/);
  });

  it("applies an answer that is the shapes' first option, or agrees with a person's rule", () => {
    const q = Question.parse(question());
    expect(questionBar(q, 1, { shapesFirst: true })).toBe("agrees-with-shapes");
    expect(questionBar(q, 1, { shapesFirst: false })).toBeUndefined();
    expect(questionBar(q, 1, { shapesFirst: false, ruleAgrees: true })).toBe("person-rule");
  });
});

describe("a correction's rule (ADR 0181, part 2; as ADR 0153 --match)", () => {
  it("derives the path prefix the corrected call shares with its siblings", () => {
    expect(
      deriveMatch({ path: "/forge/refunds/{id}/status" }, [
        { path: "/forge/refunds/request" },
        { path: "/forge/refunds/{id}/cancel" },
      ]),
    ).toEqual({ kind: "path", match: "/forge/refunds/**" });
    // No sibling: the call's own folder.
    expect(deriveMatch({ path: "/forge/limits/{id}" }, [])).toEqual({
      kind: "path",
      match: "/forge/limits/**",
    });
    // A topic: its pattern, a dotted name with the last part open.
    expect(
      deriveMatch({ topic: "forge.payments.settled" }, [{ topic: "forge.payments.failed" }]),
    ).toEqual({ kind: "topic", match: "forge.payments.*" });
    // A host: the labels it shares with its siblings.
    expect(
      deriveMatch({ host: "limits.payments.forge.internal" }, [
        { host: "fees.payments.forge.internal" },
      ]),
    ).toEqual({ kind: "host", match: "*.payments.forge.internal" });
  });

  it("says which items a rule covers", () => {
    expect(matchCovers("/forge/refunds/**", { path: "/forge/refunds/{id}/status" })).toBe(true);
    expect(matchCovers("/forge/refunds/**", { path: "/forge/refundsx/a" })).toBe(false);
    expect(matchCovers("forge.payments.*", { topic: "forge.payments.settled" })).toBe(true);
    expect(matchCovers("forge.payments.*", { topic: "forge.limits.changed" })).toBe(false);
    expect(matchCovers("*.payments.forge.internal", { host: "fees.payments.forge.internal" })).toBe(
      true,
    );
  });
});

describe("batches, the audit's AI kind and the pause (ADR 0181, parts 2 and 3)", () => {
  it("names a batch by its time and a random part", () => {
    const id = newBatchId(new Date("2026-11-08T10:15:00Z"), () => 0.5);
    expect(id).toMatch(/^b-20261108-101500-[0-9a-f]{6}$/);
    expect(BatchId.safeParse(id).success).toBe(true);
    expect(
      DecisionBatch.safeParse({
        schema: 1,
        id,
        kind: "ai",
        at: "2026-11-08T10:15:00.000Z",
        by: ai,
        applied: [{ kind: "link", repo: "forge-refunds", fact: "c-status", line: "{}" }],
        reverted: [],
      }).success,
    ).toBe(true);
  });

  it("counts audited AI decisions apart, and pauses deciding below the bar", () => {
    const item = (n: number, answer: "right" | "wrong"): AuditItemT => ({
      id: `ai:question:q-00000000000${n}`,
      kind: "ai",
      of: "question",
      claim: "AI answered forge-gw",
      cites: ["questions/q.yaml:1"],
      answer,
    });
    const p = auditPrecision([item(1, "right"), item(2, "right"), item(3, "wrong")]);
    expect(p.ai).toMatchObject({ right: 2, wrong: 1, precision: 0.667 });
    expect(p.facts.drawn).toBe(0);
    const settings = { links: "auto", questions: "auto", minPrecision: 0.95 } as const;
    const paused = aiPause(settings, p.ai);
    expect(paused.links).toBe("propose");
    expect(paused.questions).toBe("propose");
    expect(paused.paused?.why).toMatch(/66\.7%.*95%/);
    const fine = aiPause(settings, auditPrecision([item(1, "right")]).ai);
    expect(fine).toEqual({ links: "auto", questions: "auto" });
    // Nothing audited yet: as configured.
    expect(aiPause(settings, auditPrecision([]).ai)).toEqual({ links: "auto", questions: "auto" });
  });
});

describe("review round 48: a person's word stands over the AI's in the join, and a rule stays narrow", () => {
  const aiPair = {
    repo: "forge-gw",
    entry: "e-payments-status",
    path: "/v2/payments/{paymentId}/status",
    by: "atticus",
    ai: { runtime: "copilot-acp", run: ai.run },
  };
  it("a person's answer to the targets question outranks an AI pairing, None of these too", () => {
    const none = joinFacts({
      repos,
      pairs: { "forge-refunds": { "c-status": aiPair } },
      targets: { "forge-refunds": { "c-status": NO_TARGET } },
      explain: true,
    });
    expect(none.joins.find((x) => x.call.fact === "c-status")).toBeUndefined();
    expect(none.left?.find((x) => x.call.fact === "c-status")?.reason).toBe("answered-none");
    const named = joinFacts({
      repos,
      pairs: { "forge-refunds": { "c-status": aiPair } },
      targets: { "forge-refunds": { "c-status": "forge-gw" } },
    });
    const j = named.joins.find((x) => x.call.fact === "c-status")!;
    expect(j.paired).toBeUndefined();
    expect(joinFlagsOf(j)).not.toContain(JOINED_BY_AI);
    // An AI answer doesn't outrank the AI's own pairing (as before).
    const both = joinFacts({
      repos,
      pairs: { "forge-refunds": { "c-status": aiPair } },
      targets: { "forge-refunds": { "c-status": NO_TARGET } },
      aiTargets: { "forge-refunds": { "c-status": { runtime: "copilot-acp", run: ai.run } } },
    });
    expect(both.joins.find((x) => x.call.fact === "c-status")?.paired?.ai).toBeDefined();
  });

  it("a person's unlink outranks an AI targets answer; a person's answer still stands", () => {
    const status = {
      kind: "call" as const,
      file: "src/main/java/forge/refunds/GwClient.java",
      line: 40,
      value: "/payments/{id}/status",
    };
    const unlink = FactCorrection.parse({
      schemaVersion: 2,
      fact: "c-status",
      target: status,
      action: "unlink",
      by: "pat",
      at: "2026-11-08T11:00:00.000Z",
    });
    // As before, a plain read of the pairings has none; the join's read says the person declined it.
    expect(pairsFromCorrections(refunds.facts, [unlink])).toEqual({});
    const declined = pairsFromCorrections(refunds.facts, [unlink], { declined: true });
    expect(declined).toEqual({
      "c-status": { path: "/payments/{id}/status", by: "pat", none: true },
    });
    const aiAnswered = joinFacts({
      repos,
      pairs: { "forge-refunds": declined },
      targets: { "forge-refunds": { "c-status": "forge-gw" } },
      aiTargets: { "forge-refunds": { "c-status": { runtime: "copilot-acp", run: ai.run } } },
      explain: true,
    });
    expect(aiAnswered.joins.find((x) => x.call.fact === "c-status")).toBeUndefined();
    expect(aiAnswered.left?.find((x) => x.call.fact === "c-status")?.reason).toBe("answered-none");
    const personAnswered = joinFacts({
      repos,
      pairs: { "forge-refunds": declined },
      targets: { "forge-refunds": { "c-status": "forge-gw" } },
    });
    expect(personAnswered.joins.find((x) => x.call.fact === "c-status")?.how).toBe("answer");
    // The Connect panel never lists a declined call as paired.
    const cands = linkCandidates({
      from: "forge-refunds",
      facts: refunds.facts,
      join: joinFacts({ repos }),
      apis,
      pairs: declined,
      to: { repo: "forge-gw" },
    });
    expect(cands.calls.find((c) => c.fact === "c-status")?.status).not.toBe("paired");
  });

  it("derives the longest prefix a sibling shares, never one widened by a distant sibling", () => {
    expect(
      deriveMatch({ path: "/api/v1/limits/{id}" }, [
        { path: "/api/v1/limits/daily" },
        { path: "/api/v1/fees/{id}" },
      ]),
    ).toEqual({ kind: "path", match: "/api/v1/limits/**" });
    // Only a distant sibling: the corrected item's own folder, not /api/v1/**.
    expect(deriveMatch({ path: "/api/v1/limits/{id}" }, [{ path: "/api/v1/fees/{id}" }])).toEqual({
      kind: "path",
      match: "/api/v1/limits/**",
    });
    // A sibling sharing more than the folder's two segments still widens it to what they share.
    expect(
      deriveMatch({ path: "/api/v1/limits/daily/{id}" }, [{ path: "/api/v1/limits/weekly" }]),
    ).toEqual({ kind: "path", match: "/api/v1/limits/**" });
  });
});
