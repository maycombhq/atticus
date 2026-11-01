import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOrgPack,
  NO_TARGET,
  parseFacts,
  parseRecord,
  type CatalogRecord,
  type Fact,
  type FactOf,
  type FactsJoinResult,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  estateRepos,
  groupedTargetDrafts,
  mergeEstate,
  splitTargetGroups,
  staleTargetQuestions,
  targetGroupQuestion,
  targetPathPrefix,
  targetQuestionDrafts,
  targetsFromAnswers,
  TARGETS_NONE,
  TARGETS_SPLIT,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * Q1 and J6: a call's target question is asked once for every call that goes the same way (the
 * repo, the target it names or its host or base, and its path prefix), one answer fans out to
 * every call of the group, and an open question the code now answers retires itself. Answered
 * per-call questions keep working as they are.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const meta = join(fixtures, "metarepo");
const REPO = "forge-ledger";
const NOTIFIER = "src/main/java/forge/ledger/Notifier.java";

const base = (): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

/** The fixture's notify call with no host, and two more calls under /notify, also with none. */
const grouped = (): Fact[] => {
  const facts = base().map((f) =>
    f.id === "c-notify" && f.kind === "call" ? { ...f, host: undefined } : f,
  );
  const notify = facts.find((f): f is FactOf<"call"> => f.id === "c-notify" && f.kind === "call")!;
  const more = (id: string, path: string, line: number): Fact =>
    ({
      ...notify,
      id,
      path,
      cite: { ...notify.cite, line, value: path, quote: `client.post("${path}", body);` },
    }) as Fact;
  return [
    ...facts,
    more("c-notify-batch", "/notify/batch", 10),
    more("c-notify-sms", "/notify/sms/{to}", 11),
  ];
};

let op: OrgPack;
let records: CatalogRecord[];
beforeAll(async () => {
  op = await loadOrgPack(join(meta, "org-pack"));
  const raw = (parse(readFileSync(join(meta, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  records = mergeEstate(op, estateRepos(op), raw).records;
});

const answered = (
  q: { id: string; question: string; evidence: string[]; options: Question["options"] },
  option: number,
): Question =>
  ({
    schemaVersion: 2,
    id: q.id,
    askedBy: {
      step: TARGETS_STEP,
      command: "atticus verify forge-ledger --write",
      at: "2026-10-30T10:00:00.000Z",
    },
    repo: REPO,
    question: q.question,
    options: q.options,
    evidence: q.evidence,
    scope: { level: "repo", id: REPO },
    state: "answered",
    rerun: "atticus verify forge-ledger --write",
    answer: {
      option,
      by: "dana.okafor",
      at: "2026-10-30T11:00:00.000Z",
      scope: { level: "repo", id: REPO },
    },
  }) as Question;

const open = (q: {
  id: string;
  question: string;
  evidence: string[];
  options: Question["options"];
}) => {
  const { answer: _a, ...rest } = answered(q, 1);
  return { ...rest, state: "open" } as Question;
};

const ALL = new Set(["c-notify", "c-notify-batch", "c-notify-sms"]);

describe("targetPathPrefix: the part of a path a group shares", () => {
  it("is the first segment, with an api or version segment in front kept", () => {
    expect(targetPathPrefix("/notify")).toBe("/notify");
    expect(targetPathPrefix("/notify/sms/{to}")).toBe("/notify");
    expect(targetPathPrefix("/v1/rates/{pair}")).toBe("/v1/rates");
    expect(targetPathPrefix("/api/v2/accounts/{id}/balance?x=1")).toBe("/api/v2/accounts");
    expect(targetPathPrefix("/{tenant}/accounts")).toBe("/");
    expect(targetPathPrefix("forge.ledger.Entries/Post")).toBe("forge.ledger.Entries");
  });
});

describe("groupedTargetDrafts: one question for the calls that go the same way (Q1)", () => {
  it("asks the three /notify calls once, with every line as evidence", () => {
    const facts = grouped();
    const drafts = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.factIds).toEqual(["c-notify", "c-notify-batch", "c-notify-sms"]);
    expect(d.draft.question).toBe(
      "Which repo or system answers the calls forge-ledger makes under /notify?",
    );
    expect(d.draft.question).toBe(
      targetGroupQuestion(
        REPO,
        facts.find((f): f is FactOf<"call"> => f.id === "c-notify" && f.kind === "call")!,
      ),
    );
    expect(d.draft.evidence).toEqual([`${NOTIFIER}:9`, `${NOTIFIER}:10`, `${NOTIFIER}:11`]);
    expect(d.draft.options.map((o) => o.label)).toEqual([
      "notify-api",
      "northwind-fx",
      TARGETS_SPLIT,
      TARGETS_NONE,
    ]);
    expect(d.draft.options[0]!.means).toContain("POST /notify/batch");
  });

  it("keeps the per-call question, word for word, for a call alone in its group", () => {
    const facts = grouped();
    const drafts = groupedTargetDrafts(facts, records, op, undefined, {
      ask: new Set(["c-notify"]),
    });
    const [one] = targetQuestionDrafts(facts, records, op).filter((t) => t.factId === "c-notify");
    expect(drafts).toEqual([{ ...one, factIds: ["c-notify"] }]);
  });

  it("asks apart the calls that name different targets, hosts or bases, or another prefix", () => {
    const facts = grouped().map((f) =>
      f.id === "c-notify-sms" && f.kind === "call" ? { ...f, base: "sms.client.base-url" } : f,
    );
    const drafts = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    expect(drafts.map((d) => d.factIds)).toEqual([
      ["c-notify", "c-notify-batch"],
      ["c-notify-sms"],
    ]);
  });

  it("asks each call on its own once a person said they don't all go to one place", () => {
    const facts = grouped();
    const [g] = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const split = answered(
      { ...g!.draft, id: g!.id },
      g!.draft.options.findIndex((o) => o.label === TARGETS_SPLIT) + 1,
    );
    const drafts = groupedTargetDrafts(facts, records, op, undefined, {
      ask: ALL,
      split: splitTargetGroups([split]),
    });
    expect(drafts.map((d) => d.factIds)).toEqual([
      ["c-notify"],
      ["c-notify-batch"],
      ["c-notify-sms"],
    ]);
  });

  it("is deterministic: the same facts give the same drafts and ids", () => {
    const a = groupedTargetDrafts(grouped(), records, op, undefined, { ask: ALL });
    const b = groupedTargetDrafts([...grouped()].reverse(), records, op, undefined, { ask: ALL });
    expect(b).toEqual(a);
  });
});

describe("targetsFromAnswers: one answer fans out to the group (Q1)", () => {
  it("names the target for every call of an answered group", () => {
    const facts = grouped();
    const [g] = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const q = answered({ ...g!.draft, id: g!.id }, 1);
    expect(targetsFromAnswers(REPO, facts, [q])).toEqual({
      "c-notify": "notify-api",
      "c-notify-batch": "notify-api",
      "c-notify-sms": "notify-api",
    });
  });

  it("covers a call added to the group after the answer, when it still has no target", () => {
    const facts = grouped();
    const [g] = groupedTargetDrafts(facts, records, op, undefined, {
      ask: new Set(["c-notify", "c-notify-batch"]),
    });
    const q = answered({ ...g!.draft, id: g!.id }, 1);
    expect(Object.keys(targetsFromAnswers(REPO, facts, [q])).sort()).toEqual([...ALL].sort());
  });

  it("never gives a group's answer to a call with a host or URL of its own", () => {
    const facts = grouped().map((f) =>
      f.id === "c-notify-sms" && f.kind === "call" ? { ...f, host: "sms.internal" } : f,
    );
    const g = {
      id: "q-000000000000",
      question: targetGroupQuestion(
        REPO,
        facts.find((f): f is FactOf<"call"> => f.id === "c-notify" && f.kind === "call")!,
      ),
      evidence: [`${NOTIFIER}:9`],
      options: [{ label: "notify-api", means: "m", changes: "c" }],
    };
    expect(targetsFromAnswers(REPO, facts, [answered(g, 1)])).toEqual({
      "c-notify": "notify-api",
      "c-notify-batch": "notify-api",
    });
  });

  it("keeps a call's own answered question over its group's, and None of these binds", () => {
    const facts = grouped();
    const [one] = targetQuestionDrafts(facts, records, op).filter((t) => t.factId === "c-notify");
    const own = answered({ ...one!.draft, id: one!.id }, one!.draft.options.length);
    const [g] = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const group = answered({ ...g!.draft, id: g!.id }, 1);
    expect(targetsFromAnswers(REPO, facts, [group, own])).toEqual({
      "c-notify": NO_TARGET,
      "c-notify-batch": "notify-api",
      "c-notify-sms": "notify-api",
    });
  });

  it("reads nothing from a split answer", () => {
    const facts = grouped();
    const [g] = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const n = g!.draft.options.findIndex((o) => o.label === TARGETS_SPLIT) + 1;
    expect(targetsFromAnswers(REPO, facts, [answered({ ...g!.draft, id: g!.id }, n)])).toEqual({});
  });
});

const emptyJoin = (): FactsJoinResult => ({
  joins: [],
  asks: [],
  misses: [],
  lineage: [],
  gaps: [],
});
const joinOf = (
  fact: string,
  how: "named" | "host" | "path",
  inferred = false,
): FactsJoinResult["joins"][number] => ({
  call: { repo: REPO, fact, component: "ledger-api", at: `${NOTIFIER}:9` },
  entry: { repo: "forge-notify", fact: "e-notify", component: "notify-api", at: "src/N.java:3" },
  how,
  ...(inferred ? { inferred: { within: "estate" as const } } : {}),
  callType: "rest",
  method: "POST",
  path: "/notify",
  interface: "if-0000000000000000",
});

describe("staleTargetQuestions: questions the code answers now, or asked another way (J6, Q1)", () => {
  const facts = grouped();
  const perCall = (id: string) => {
    const t = targetQuestionDrafts(facts, records, op).find((x) => x.factId === id)!;
    return open({ ...t.draft, id: t.id });
  };

  it("retires an open per-call question once its call joins without an answer", () => {
    const q = perCall("c-notify");
    const join = { ...emptyJoin(), joins: [joinOf("c-notify", "host")] };
    const out = staleTargetQuestions({
      repo: REPO,
      facts,
      open: [q],
      drafted: [],
      asked: new Set(),
      join,
    });
    expect(out).toEqual([
      {
        id: q.id,
        why: "POST /notify joins notify-api in forge-notify: the manifest's hosts and base paths decide it",
      },
    ]);
  });

  it("retires an open question whose call now names its target", () => {
    const q = perCall("c-notify");
    const named = facts.map((f) =>
      f.id === "c-notify" && f.kind === "call" ? { ...f, to: "northwind-fx" } : f,
    );
    const out = staleTargetQuestions({
      repo: REPO,
      facts: named,
      open: [q],
      drafted: [],
      asked: new Set(),
      join: emptyJoin(),
    });
    expect(out.map((x) => x.why)).toEqual(["POST /notify now names northwind-fx in the code"]);
  });

  it("keeps an open question whose call is joined only by a guess, or still asked", () => {
    const q = perCall("c-notify");
    const join = { ...emptyJoin(), joins: [joinOf("c-notify", "path", true)] };
    expect(
      staleTargetQuestions({ repo: REPO, facts, open: [q], drafted: [], asked: new Set(), join }),
    ).toEqual([]);
    expect(
      staleTargetQuestions({
        repo: REPO,
        facts,
        open: [q],
        drafted: [],
        asked: new Set(["c-notify"]),
        join: emptyJoin(),
      }),
    ).toEqual([]);
  });

  it("keeps an open question whose call is joined by host only through a guessed setting or a disputed host (J0, J1)", () => {
    const q = perCall("c-notify");
    for (const guess of [
      "joined-by-platform-setting",
      "joined-by-folder-name",
      "joined-despite-conflict",
    ] as const) {
      const join = {
        ...emptyJoin(),
        joins: [{ ...joinOf("c-notify", "host"), guesses: [guess] }],
      };
      expect(
        staleTargetQuestions({ repo: REPO, facts, open: [q], drafted: [], asked: new Set(), join }),
        guess,
      ).toEqual([]);
    }
  });

  it("retires a group question only once every call of it joins", () => {
    const [g] = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const q = open({ ...g!.draft, id: g!.id });
    const some = {
      ...emptyJoin(),
      joins: [joinOf("c-notify", "named"), joinOf("c-notify-batch", "named")],
    };
    expect(
      staleTargetQuestions({
        repo: REPO,
        facts,
        open: [q],
        drafted: [],
        asked: new Set(["c-notify-sms"]),
        join: some,
      }),
    ).toEqual([]);
    const all = { ...some, joins: [...some.joins, joinOf("c-notify-sms", "named")] };
    const out = staleTargetQuestions({
      repo: REPO,
      facts,
      open: [q],
      drafted: [],
      asked: new Set(),
      join: all,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.why).toContain(
      "POST /notify/sms/{to} joins notify-api in forge-notify: the call names it",
    );
  });

  it("replaces an open per-call question with the group question that asks it now", () => {
    const q = perCall("c-notify-batch");
    const drafted = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const out = staleTargetQuestions({
      repo: REPO,
      facts,
      open: [q],
      drafted,
      asked: ALL,
      join: emptyJoin(),
    });
    expect(out).toEqual([
      {
        id: q.id,
        why: `its calls are asked now in ${drafted[0]!.id}`,
        replacedBy: [drafted[0]!.id],
      },
    ]);
  });

  it("never lists a question this run drafts, or one with no call left in the facts", () => {
    const drafted = groupedTargetDrafts(facts, records, op, undefined, { ask: ALL });
    const q = open({ ...drafted[0]!.draft, id: drafted[0]!.id });
    const gone = open({
      id: "q-00000000beef",
      question: "Which repo or system answers GET /gone, which ledger-api calls?",
      evidence: ["src/Gone.java:1"],
      options: [],
    });
    expect(
      staleTargetQuestions({
        repo: REPO,
        facts,
        open: [q, gone],
        drafted,
        asked: ALL,
        join: emptyJoin(),
      }),
    ).toEqual([]);
  });
});
