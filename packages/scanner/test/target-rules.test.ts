import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnswerMatch,
  NO_TARGET,
  parseFacts,
  questionId,
  type Fact,
  type FactOf,
  type Question,
} from "@maycombhq/core";
import {
  ruleCoversCall,
  ruledTargets,
  staleTargetQuestions,
  targetQuestionFor,
  targetsFromAnswers,
  TARGETS_NONE,
  TARGETS_SPLIT,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * Answer by rule (ADR 0153, Q2): a targets answer with a path prefix or host pattern covers every
 * call that matches and still has no target, now or later, in each repo its scope allows; a call's
 * own answer and its group's still come first, and an open question whose calls a rule covers
 * retires, naming the rule's question.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";

/** The fixture's facts, the notify call without its host, and calls under /forge/limits. */
const facts = (repo = REPO): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const all = r.facts.map((f) =>
    f.id === "c-notify" && f.kind === "call" ? { ...f, host: undefined } : f,
  );
  const notify = all.find((f): f is FactOf<"call"> => f.id === "c-notify" && f.kind === "call")!;
  const more = (id: string, path: string, line: number, extra: Partial<FactOf<"call">> = {}) =>
    ({
      ...notify,
      ...extra,
      id,
      path,
      cite: { ...notify.cite, line, value: path, quote: `client.get("${path}");` },
    }) as Fact;
  return [
    ...all,
    more("c-limits", "/forge/limits/{account}", 20),
    more("c-limits-daily", "/forge/limits/daily", 21),
    more("c-limit-other", "/forge/limitsx", 22),
    more("c-grpc-fees", "forge.fees.Fees/Quote", 23, {
      callType: "grpc",
      host: "fees.payments.forge.internal:9090",
    }),
  ].map((f) => ({ ...f, repo }));
};

const ruleQ = (o: {
  id?: string;
  match: string;
  label?: string;
  text?: string;
  scope?: { level: "repo" | "repo-type"; id: string };
  repo?: string;
  at?: string;
}): Question =>
  ({
    schemaVersion: 4,
    id: o.id ?? "q-aaaaaaaaaaaa",
    askedBy: {
      step: TARGETS_STEP,
      command: "atticus verify x --write",
      at: "2026-11-01T10:00:00.000Z",
    },
    repo: o.repo ?? REPO,
    question: `Which repo or system answers what ${o.match} covers?`,
    options: [
      { label: o.label ?? "limits-api", means: "m", changes: "c" },
      { label: TARGETS_SPLIT, means: "m", changes: "c" },
      { label: TARGETS_NONE, means: "m", changes: "c" },
    ],
    evidence: ["src/x.java:1"],
    scope: { level: "repo", id: o.repo ?? REPO },
    state: "answered",
    rerun: "atticus verify x --write",
    answer: {
      ...(o.text ? { text: o.text } : { option: 1 }),
      by: "dana.okafor",
      at: o.at ?? "2026-11-01T11:00:00.000Z",
      scope: o.scope ?? { level: "repo", id: o.repo ?? REPO },
      match: o.match,
    },
  }) as Question;

const call = (fs: Fact[], id: string) =>
  fs.find((f): f is FactOf<"call"> => f.id === id && f.kind === "call")!;

describe("ruleCoversCall", () => {
  it("a path prefix covers the path and what is under it, by whole segments", () => {
    const fs = facts();
    expect(ruleCoversCall("/forge/limits/**", call(fs, "c-limits"), fs)).toBe(true);
    expect(ruleCoversCall("/forge/limits", call(fs, "c-limits-daily"), fs)).toBe(true);
    expect(ruleCoversCall("/forge/limits/**", call(fs, "c-limit-other"), fs)).toBe(false);
    // `/**` is every path of the repo: one answer for a proxy that forwards everything to one place.
    expect(AnswerMatch.safeParse("/**").success).toBe(true);
    expect(AnswerMatch.safeParse("/").success).toBe(false);
    for (const id of ["c-limits", "c-limits-daily", "c-limit-other"])
      expect(ruleCoversCall("/**", call(fs, id), fs)).toBe(true);
    expect(ruleCoversCall("/forge/limits/**", call(fs, "c-notify"), fs)).toBe(false);
  });

  it("a host pattern covers a call on a host it matches, as the manifest matches hosts", () => {
    const fs = facts();
    expect(ruleCoversCall("*.payments.forge.internal", call(fs, "c-grpc-fees"), fs)).toBe(true);
    expect(ruleCoversCall("*.ledger.forge.internal", call(fs, "c-grpc-fees"), fs)).toBe(false);
    expect(ruleCoversCall("*.payments.forge.internal", call(fs, "c-limits"), fs)).toBe(false);
  });
});

describe("targetsFromAnswers with a rule (ADR 0153)", () => {
  it("one answer names the target of every call it covers, the calls found later too", () => {
    const fs = facts();
    expect(targetsFromAnswers(REPO, fs, [ruleQ({ match: "/forge/limits/**" })])).toEqual({
      "c-limits": "limits-api",
      "c-limits-daily": "limits-api",
    });
    expect(
      targetsFromAnswers(REPO, fs, [
        ruleQ({ match: "*.payments.forge.internal", label: "fees-api" }),
      ]),
    ).toEqual({ "c-grpc-fees": "fees-api" });
  });

  it("None of these by rule binds every call it covers; the split option names nothing", () => {
    const fs = facts();
    const none = ruleQ({ match: "/forge/limits/**" });
    none.answer!.option = 3;
    expect(targetsFromAnswers(REPO, fs, [none])).toEqual({
      "c-limits": NO_TARGET,
      "c-limits-daily": NO_TARGET,
    });
    const split = ruleQ({ match: "/forge/limits/**" });
    split.answer!.option = 2;
    expect(targetsFromAnswers(REPO, fs, [split])).toEqual({});
  });

  it("reaches another repo only when the scope allows it: its type, never a repo scope", () => {
    const fs = facts("forge-fees");
    const repoScoped = ruleQ({ match: "/forge/limits/**" });
    expect(targetsFromAnswers("forge-fees", fs, [repoScoped], { repoType: "spring-boot" })).toEqual(
      {},
    );
    const typed = ruleQ({
      match: "/forge/limits/**",
      scope: { level: "repo-type", id: "spring-boot" },
    });
    expect(targetsFromAnswers("forge-fees", fs, [typed], { repoType: "spring-boot" })).toEqual({
      "c-limits": "limits-api",
      "c-limits-daily": "limits-api",
    });
    expect(targetsFromAnswers("forge-fees", fs, [typed], { repoType: "spa" })).toEqual({});
    expect(targetsFromAnswers("forge-fees", fs, [typed])).toEqual({});
  });

  it("a call's own answer comes before a rule; the repo's rule before its type's, then the longer", () => {
    const fs = facts();
    const asked = targetQuestionFor(call(fs, "c-limits"))!;
    const own = ruleQ({
      id: questionId({ step: TARGETS_STEP, repo: REPO, ...asked }),
      match: "/forge/limits/{account}",
      label: "own-api",
    });
    own.question = asked.question;
    own.evidence = asked.evidence;
    delete own.answer!.match;
    const typed = ruleQ({
      id: "q-bbbbbbbbbbbb",
      match: "/forge/limits/daily",
      label: "daily-api",
      scope: { level: "repo-type", id: "spring-boot" },
    });
    const broad = ruleQ({ id: "q-cccccccccccc", match: "/forge/**", label: "forge-api" });
    const narrow = ruleQ({ id: "q-dddddddddddd", match: "/forge/limits/**" });
    const got = targetsFromAnswers(REPO, fs, [typed, broad, narrow, own], {
      repoType: "spring-boot",
    });
    expect(got["c-limits"]).toBe("own-api");
    expect(got["c-limits-daily"]).toBe("limits-api");
    expect(got["c-limit-other"]).toBe("forge-api");
  });

  it("a call that names its target, or has a URL, is never read from a rule", () => {
    const fs = facts();
    const got = ruledTargets(REPO, fs, [ruleQ({ match: "/v1/**" })]);
    expect(got.has("c-fx-rate")).toBe(false);
  });
});

describe("staleTargetQuestions with a rule (ADR 0153)", () => {
  it("retires an open question whose calls a rule covers, naming the rule's question", () => {
    const fs = facts();
    const rule = ruleQ({ match: "/forge/limits/**" });
    const own = targetQuestionFor(call(fs, "c-limits-daily"))!;
    const openQ = {
      ...rule,
      id: questionId({ step: TARGETS_STEP, repo: REPO, ...own }),
      question: own.question,
      evidence: own.evidence,
      state: "open",
      answer: undefined,
    } as unknown as Question;
    const stale = staleTargetQuestions({
      repo: REPO,
      facts: fs,
      open: [openQ],
      drafted: [],
      asked: new Set(),
      ruled: ruledTargets(REPO, fs, [rule]),
    });
    expect(stale).toEqual([
      {
        id: openQ.id,
        why: `POST /forge/limits/daily is answered by rule in ${rule.id} (/forge/limits/**)`,
        replacedBy: [rule.id],
      },
    ]);
  });
});
