import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseFacts,
  type Fact,
  type FactOf,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  nameWords,
  pickerLines,
  targetPicker,
  targetQuestionDrafts,
  targetSuggestions,
  TARGETS_ANOTHER,
  TARGETS_MAX_SUGGESTED,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * ADR 0162 (F8): a call's target question suggests every repo of the manifest, read or not, ranked
 * by the evidence, each saying why and whether it is read; then "Another repo…" and the picker of
 * the whole estate. On the invented bank-shaped estate (fixtures/link-estate).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const REPOS = [
  "forge-portal-bff",
  "forge-proxy-accounts-v1",
  "forge-proxy-payments-v1",
  "forge-proxy-northwind-v1",
  "forge-accounts",
  "forge-payments",
  "forge-cards",
  "forge-notifications",
  "forge-starter",
  "forge-deploy-config",
];
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The estate as a write of `repo` sees it, without the repos left unread. */
const estateBut = (repo: string, unread: readonly string[] = []) =>
  REPOS.filter((r) => r !== repo && !unread.includes(r)).map((r) => ({
    repo: r,
    facts: factsOf(r),
  }));

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(FIX, "org-pack"));
});

const callOf = (repo: string, id: string, patch: Partial<FactOf<"call">> = {}): FactOf<"call"> => {
  const f = factsOf(repo).find((x): x is FactOf<"call"> => x.kind === "call" && x.id === id)!;
  return { ...f, host: undefined, base: undefined, to: undefined, ...patch };
};

describe("nameWords", () => {
  it("splits keys, classes and hosts into the words that name things", () => {
    expect(nameWords("forge.cards.base-url")).toEqual(["forge", "card"]);
    expect(nameWords("LimitsClient")).toEqual(["limit"]);
    expect(nameWords("forge-proxy-accounts-v1")).toEqual(["forge", "account"]);
  });
});

describe("targetSuggestions on the link estate", () => {
  it("ranks the proxy whose BasePath the call's path is under first, and says why", () => {
    const f = callOf("forge-portal-bff", "call.get.forge-accounts-v1-accounts-id");
    const s = targetSuggestions(f, {
      op,
      records: [],
      facts: factsOf("forge-portal-bff"),
      estate: estateBut("forge-portal-bff"),
    });
    expect(s[0]).toMatchObject({ label: "forge-proxy-accounts-v1", kind: "repo", read: true });
    expect(s[0]!.why.join("; ")).toContain(
      "its basePath /forge/accounts/v1 matches: its proxy's BasePath (forge-proxy-accounts-v1 apiproxy/forge-accounts-v1.xml:1)",
    );
    expect(s[0]!.why.join("; ")).toContain(
      "serves GET /forge/accounts/v1/accounts/{id} (apiproxy/proxies/default.xml:4)",
    );
  });

  it("suggests a repo not read yet by a Route's base path and its path's words", () => {
    const f = callOf("forge-payments", "call.get.limits-id", {
      path: "/forge-svc/cards/limits/{id}",
    });
    const s = targetSuggestions(f, {
      op,
      records: [],
      facts: factsOf("forge-payments"),
      estate: estateBut("forge-payments", ["forge-cards"]),
    });
    expect(s[0]).toMatchObject({ label: "forge-cards", read: false });
    expect(s[0]!.why).toEqual([
      "its basePath /forge-svc/cards matches: the route cards-api (forge-deploy-config apps/cards/route.yaml:4)",
      "named like the path /forge-svc/cards/limits/{id}",
    ]);
  });

  it("reads the config key, the manifest's description and the caller's earlier answers", () => {
    const f = callOf("forge-payments", "call.get.limits-id", { base: "forge.cards.base-url" });
    const described = {
      ...op,
      profiles: op.profiles.map((p) => ({
        ...p,
        repos: p.repos && {
          ...p.repos,
          repos: p.repos.repos.map((r) =>
            r.id === "forge-cards"
              ? {
                  ...r,
                  description: {
                    text: "Card limits and readiness",
                    trust: "verified" as const,
                    cites: [],
                  },
                }
              : r,
          ),
        },
      })),
    } as OrgPack;
    const earlier = {
      id: "q-000000000001",
      repo: "forge-payments",
      state: "answered",
      question: "Which repo or system answers GET /cards/{id}, which payments-api calls?",
      evidence: ["src/main/java/forge/payments/Other.java:3"],
      options: [{ label: "forge-cards", means: "m", changes: "c" }],
      answer: {
        option: 1,
        by: "pat",
        at: "2026-10-30T00:00:00Z",
        scope: { level: "repo", id: "forge-payments" },
      },
      askedBy: {
        step: TARGETS_STEP,
        command: "atticus verify forge-payments --write",
        at: "2026-10-30T00:00:00Z",
      },
    } as unknown as Question;
    const s = targetSuggestions(f, {
      op: described,
      records: [],
      facts: factsOf("forge-payments"),
      estate: estateBut("forge-payments", ["forge-cards"]),
      questions: [earlier],
    });
    const cards = s.find((x) => x.label === "forge-cards")!;
    expect(cards.why).toEqual([
      "named like the config key forge.cards.base-url",
      "its description mentions card",
      "picked for 1 other call of forge-payments",
    ]);
    expect(s[0]!.label).toBe("forge-cards");
    // forge-accounts, read, serves GET /limits/{id} too: suggested, second.
    expect(s[1]).toMatchObject({ label: "forge-accounts", read: true });
  });

  it("names an outside system by the host its aliases give", () => {
    const f = callOf("forge-payments", "call.get.limits-id", { host: "api.lanternmail.example" });
    const s = targetSuggestions(f, {
      op,
      records: [],
      facts: [],
      estate: estateBut("forge-payments"),
    });
    expect(s[0]).toMatchObject({ label: "lantern-mail", kind: "outside" });
    expect(s[0]!.why[0]).toBe("it lists api.lanternmail.example under hosts");
  });
});

describe("the targets question with the suggestions (F8)", () => {
  it("offers a bounded list, read or not said, then Another repo… and None of these", () => {
    const facts = factsOf("forge-payments").map((f) =>
      f.kind === "call" && f.id === "call.get.limits-id"
        ? { ...f, path: "/forge-svc/cards/limits/{id}" }
        : f,
    );
    const estate = estateBut("forge-payments", ["forge-cards"]);
    const out = catalogWithFacts({
      repo: "forge-payments",
      facts,
      existing: [],
      op,
      decisions: [],
      estate,
    });
    const d = targetQuestionDrafts(facts, out.records, op, out.join?.asks, { estate }).find(
      (x) => x.factId === "call.get.limits-id",
    )!;
    const labels = d.draft.options.map((o) => o.label);
    expect(labels.length).toBeLessThanOrEqual(TARGETS_MAX_SUGGESTED + 2);
    expect(labels[0]).toBe("forge-cards");
    expect(labels.slice(-2)).toEqual([TARGETS_ANOTHER, "None of these"]);
    expect(d.draft.options[0]!.means).toMatch(
      /^forge-cards \(not read yet\): its basePath \/forge-svc\/cards matches: /,
    );
    expect(d.draft.options[0]!.changes).toContain(
      "once forge-cards is read and verified (/atticus-map forge-cards)",
    );
    expect(d.draft.options.at(-2)!.means).toContain("the manifest's 10 repos (read or not)");
  });
});

describe("the Another repo… picker", () => {
  it("lists the whole manifest, the profiles' systems and the teams, a team with no system offering one", () => {
    const withTeams = {
      ...op,
      roles: {
        ...op.roles,
        teams: [
          { id: "team-cards", name: "Cards team", people: [] },
          { id: "team-ledger-ops", name: "Ledger Ops", people: [] },
        ],
      },
    } as OrgPack;
    const picks = targetPicker(withTeams, new Set(["forge-accounts"]));
    expect(picks.filter((p) => p.kind === "repo").map((p) => p.id)).toHaveLength(10);
    expect(picks.find((p) => p.id === "forge-accounts")).toMatchObject({ read: true });
    expect(picks.find((p) => p.id === "northwind-pay")).toMatchObject({
      kind: "system",
      boundary: "vendor",
    });
    expect(picks.find((p) => p.id === "team-cards")!.adds).toBeUndefined();
    expect(picks.find((p) => p.id === "team-ledger-ops")!.adds).toEqual({
      id: "team-ledger-ops-system",
      name: "Ledger Ops's system",
      boundary: "internal",
      owner: "team-ledger-ops",
    });
    expect(pickerLines(picks)[2]).toBe("Teams (2): team-cards, team-ledger-ops (no system yet)");
  });
});
