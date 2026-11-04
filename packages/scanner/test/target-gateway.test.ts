import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOrgPack,
  parseFacts,
  Question,
  type Fact,
  type FactOf,
  type OrgPack,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  groupedTargetDrafts,
  hostQuestionDrafts,
  splitTargetGroups,
  suggestionWhy,
  targetGroupQuestion,
  targetGroupWordings,
  targetRuleOffers,
  targetsFromAnswers,
  TARGETS_NO_EVIDENCE,
  TARGETS_SPLIT,
  TARGETS_STEP,
  unknownHosts,
} from "../src/index.js";

/**
 * Beta.12 (ADR 0168): a gateway proxy's routes asked once per TargetServer and path prefix, in
 * words that say what is asked ("which repo serves the routes under /accounts/** that the proxy
 * forwards to core-backend?"); options that say why each is suggested, never that it answers;
 * the rule several open questions share; and a gateway's host no proxy lists. On the invented
 * estate of fixtures/link-estate/gateway-questions.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate", "gateway-questions");
const REPOS = ["forge-proxy-core-v1", "forge-ledger-core", "forge-card-vault", "forge-teller-app"];
const PROXY = "forge-proxy-core-v1";
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const estateBut = (repo: string) =>
  REPOS.filter((r) => r !== repo).map((r) => ({ repo: r, facts: factsOf(r) }));
const oldQuestions = (): Question[] =>
  readdirSync(join(FIX, "questions")).map((n) =>
    Question.parse(parse(readFileSync(join(FIX, "questions", n), "utf8"))),
  );

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(FIX, "org-pack"));
});

/** The catalog with every repo written, in order, `last` last: as verify --write leaves it. */
const written = (last: string) => {
  let existing: ReturnType<typeof catalogWithFacts>["records"] = [];
  let out!: ReturnType<typeof catalogWithFacts>;
  for (const repo of [...REPOS.filter((r) => r !== last), last]) {
    out = catalogWithFacts({
      repo,
      facts: factsOf(repo),
      existing,
      op,
      decisions: [],
      estate: estateBut(repo),
    });
    existing = out.records;
  }
  return out;
};

const draftsOf = (repo: string) => {
  const facts = factsOf(repo);
  const estate = estateBut(repo);
  const out = written(repo);
  const ask = new Set(out.unresolved.map((u) => u.factId));
  return {
    facts,
    out,
    drafts: groupedTargetDrafts(facts, out.records, op, out.join?.asks, { ask, estate }),
  };
};

describe("a gateway proxy's target questions (beta.12)", () => {
  it("asks one question per path prefix of the routes it forwards to one TargetServer", () => {
    const { drafts } = draftsOf(PROXY);
    expect(drafts.map((d) => [d.draft.question, d.factIds.length])).toEqual([
      [
        "Which repo serves the routes under /accounts/** that forge-core-v1 forwards to core-backend?",
        3,
      ],
      [
        "Which repo serves the routes under /cards/** that forge-core-v1 forwards to core-backend?",
        2,
      ],
    ]);
  });

  it("ranks the service whose entries serve the routes first, saying how many it serves", () => {
    const { drafts } = draftsOf(PROXY);
    const [accounts, cards] = drafts;
    expect(accounts!.draft.options[0]!.label).toBe("ledger-core");
    expect(accounts!.draft.options[0]!.means).toMatch(
      /^ledger-core, built in forge-ledger-core: serves GET \/accounts\/\{id\} and 2 more under \/accounts; /,
    );
    expect(cards!.draft.options[0]!.label).toBe("card-vault");
    for (const d of drafts)
      for (const o of d.draft.options.slice(0, -4)) expect(o.means).not.toMatch(/\banswers\b/);
  });

  it("ranks the proxy first for a client's calls through the gateway's config key", () => {
    const { drafts } = draftsOf("forge-teller-app");
    const g = drafts.find((d) => d.factIds.length === 2)!;
    expect(g.draft.options[0]!.label).toBe("proxy-core-v1");
    expect(g.draft.options[0]!.means).toContain(
      "serves PUT /forge/core/v1/accounts/{id} and 1 more under /forge; its basePath /forge/core/v1 matches",
    );
  });

  it("still reads an answer, and a split, given to a group in the words asked before", () => {
    const facts = factsOf(PROXY);
    const call = facts.find(
      (f): f is FactOf<"call"> => f.kind === "call" && f.id.endsWith("accounts-id-status-forward"),
    )!;
    const [now, before] = targetGroupWordings(PROXY, call, facts);
    expect(now).toBe(targetGroupQuestion(PROXY, call, facts));
    expect(before).toBe(
      "Which repo or system answers the calls forge-proxy-core-v1 makes under /accounts through core-backend?",
    );
    const answered = (option: string) =>
      ({
        id: "q-0000000000aa",
        repo: PROXY,
        state: "answered",
        question: before,
        evidence: ["apiproxy/proxies/default.xml:10"],
        options: [{ label: option, means: "m", changes: "c" }],
        answer: {
          option: 1,
          by: "pat",
          at: "2026-10-20T00:00:00Z",
          scope: { level: "repo", id: PROXY },
        },
        askedBy: { step: TARGETS_STEP, command: "c", at: "2026-10-20T00:00:00Z" },
      }) as unknown as Question;
    expect(targetsFromAnswers(PROXY, facts, [answered("ledger-core")])[call.id]).toBe(
      "ledger-core",
    );
    // A group a person split in the older words stays split: each call asked on its own.
    const split = splitTargetGroups([answered(TARGETS_SPLIT)]);
    const { out } = draftsOf(PROXY);
    const drafts = groupedTargetDrafts(facts, out.records, op, out.join?.asks, {
      ask: new Set(out.unresolved.map((u) => u.factId)),
      split,
      estate: estateBut(PROXY),
    });
    expect(drafts.filter((d) => d.factIds.length === 1)).toHaveLength(3);
  });
});

describe("suggestionWhy", () => {
  it("says there is no evidence rather than nothing", () => {
    expect(suggestionWhy({ label: "x", kind: "repo", read: true, score: 0, why: [] })).toBe(
      TARGETS_NO_EVIDENCE,
    );
  });
});

describe("targetRuleOffers (beta.12)", () => {
  it("offers the prefix the open questions of a repo share, and nothing for one alone", () => {
    const offers = targetRuleOffers(oldQuestions(), factsOf);
    expect(offers.get("q-65f2e458d42d")).toEqual({
      match: "/accounts/**",
      ids: ["q-65f2e458d42d", "q-848df3a174aa", "q-977303dcd756"],
      calls: 3,
    });
    expect(offers.get("q-5658d5bfa1b2")!.match).toBe("/forge/**");
    // /cards: the other pin question is answered. /postings: alone.
    expect(offers.has("q-c1a79cc23ea0")).toBe(false);
    expect(offers.has("q-95d4b60a5cd0")).toBe(false);
    expect(offers.has("q-e46492df321a")).toBe(false);
  });
});

describe("a gateway's host no proxy lists (beta.12)", () => {
  it("puts the proxy whose routes the calls' paths are under first, and says the one-time fix", async () => {
    const out = written("forge-teller-app");
    const repos = REPOS.map((id) => ({
      id,
      component: id.replace(/^forge-/, ""),
      hosts: [] as string[],
    }));
    const asks = await unknownHosts({ records: out.records, repos, handle: () => undefined });
    expect(asks.map((a) => a.host)).toEqual(["api.forge.example"]);
    expect(asks[0]!.byPath).toEqual([{ repo: PROXY, serves: "GET /forge/core/v1/cards/{id}/pin" }]);
    const [d] = hostQuestionDrafts(asks);
    expect(d!.draft.options[0]!.label).toBe(PROXY);
    expect(d!.draft.options[0]!.changes).toContain(
      "on a shared gateway host, list it on each proxy repo instead",
    );
  });
});
