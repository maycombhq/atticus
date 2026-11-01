import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOrgPack, NO_TARGET, parseFacts, type Fact, type OrgPack } from "@maycombhq/core";
import { dirSource, verifyFacts } from "@maycombhq/verify";
import { measureLinks, parseLinkReference, type LinkReference } from "../src/index.js";

/**
 * P1: the links the estate join makes, measured against reference links written by hand, on an
 * invented estate shaped like a large bank's (fixtures/link-estate): Apigee proxies each in a repo
 * of their own on one gateway host, Spring Boot services behind one ingress host under
 * /forge-svc/<module>, a house starter whose wrapper client makes the calls, and base URLs left as
 * ${PLACEHOLDERS} that a deploy repo sets. The numbers are pinned, so a regression fails CI.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const COMMITS: Record<string, string> = {
  "forge-portal-bff": "a1a0001",
  "forge-proxy-accounts-v1": "b2b0002",
  "forge-proxy-payments-v1": "b2b0003",
  "forge-proxy-northwind-v1": "b2b0004",
  "forge-accounts": "c3c0005",
  "forge-payments": "c3c0006",
  "forge-cards": "c3c0007",
  "forge-notifications": "c3c0008",
  "forge-starter": "d4d0009",
  "forge-deploy-config": "e5e0010",
};
const REPOS = Object.keys(COMMITS);
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const all = () => REPOS.map((repo) => ({ repo, facts: factsOf(repo) }));
const reference = (): LinkReference => {
  const r = parseLinkReference(readFileSync(join(FIX, "reference-links.yaml"), "utf8"));
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.reference;
};

/** What the fixture's manifest still says of where each service and proxy is reached. */
const manifestFree = () => {
  const repos = op.profiles.flatMap((p) => p.repos?.repos ?? []);
  return {
    services: repos.filter((r) => r.type === "spring-boot" && (r.hosts.length || r.basePath)),
    proxies: repos.filter((r) => /^gateway/.test(r.type) && r.basePath),
  };
};

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(FIX, "org-pack"));
});

describe("the hand-written facts of the bank-shaped estate verify", () => {
  it.each(REPOS)("%s: every fact kept", async (repo) => {
    const r = await verifyFacts({
      facts: factsOf(repo),
      source: dirSource(join(FIX, "repos", repo)),
      commit: COMMITS[repo],
      // J1: each Route's `exposes` names a component the manifest lists.
      estate: {
        components: op.profiles.flatMap((p) =>
          (p.repos?.repos ?? []).flatMap((r) => [r.id, ...(r.component ? [r.component] : [])]),
        ),
      },
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(factsOf(repo).length);
  });
});

describe("measureLinks: the estate join against the reference links", () => {
  it("pins today's precision, recall and counts (a regression fails here)", () => {
    const m = measureLinks({ op, repos: all(), reference: reference() });
    expect(m.notes).toEqual([]);
    expect(m.reading).toEqual({
      entries: { want: 15, found: 15 },
      calls: { want: 17, found: 16 },
      missed: ["forge-portal-bff call GET /forge/payments/v1/payments/{id}"],
    });
    expect(m.links).toEqual({
      want: 13,
      joined: 11,
      right: 10,
      precision: 0.909,
      recall: 0.769,
      asked: 1,
      missed: 0,
      unlinked: 1,
      notRead: 1,
      inferred: { joined: 3, right: 2 },
      outside: { want: 4, got: 3, right: 3 },
      none: { want: 0, right: 0 },
    });
  });

  it("J1: takes the services' hosts and base paths from the deploy repo's Routes, and the proxies' from their BasePath", () => {
    // repos.manifest.yaml lists only the gateway's host (ADR 0143): the same figures as when it
    // listed every host and base path, so the facts say what the manifest no longer needs to.
    const without = all().map(({ repo, facts }) => ({
      repo,
      facts: facts.map((f) =>
        f.kind === "deploy" ? ({ ...f, host: undefined, basePath: undefined } as Fact) : f,
      ),
    }));
    const m = measureLinks({ op, repos: without, reference: reference() });
    // Without them nothing says where the services are: each call to the ingress host is asked,
    // and the portal's calls stop at a proxy whose forwarding call is asked (0.5 and 0.231,
    // against 0.909 and 0.769 with them).
    expect(m.links).toMatchObject({
      joined: 6,
      right: 3,
      precision: 0.5,
      recall: 0.231,
      asked: 6,
    });
    const exposed = manifestFree();
    expect(exposed.services).toEqual([]);
    expect(exposed.proxies).toEqual([]);
  });

  it("says, call by call, what each reached and how", () => {
    const m = measureLinks({ op, repos: all(), reference: reference() });
    const rows = m.calls.map(
      (c) =>
        `${c.right ? "ok " : "-- "}${c.repo} ${c.call} -> ${
          c.got.kind === "joined"
            ? `${c.got.repo}${c.got.via?.length ? ` via ${c.got.via.join(", ")}` : ""}${c.got.inferred ? ` (${c.got.inferred})` : ""}`
            : c.got.kind === "outside"
              ? `outside ${c.got.system}`
              : c.got.kind === "asked"
                ? `asked (${c.got.reason})`
                : c.got.kind
        }`,
    );
    expect(rows).toEqual([
      "ok forge-portal-bff GET /forge/accounts/v1/accounts/{id} -> forge-accounts via forge-proxy-accounts-v1",
      "ok forge-portal-bff POST /forge/payments/v1/payments -> forge-payments via forge-proxy-payments-v1",
      "-- forge-portal-bff GET /forge/payments/v1/payments/{id} -> not-read",
      "ok forge-proxy-accounts-v1 GET /forge-svc/accounts/accounts/{id} -> forge-accounts",
      "ok forge-proxy-payments-v1 POST /forge-svc/payments/payments -> forge-payments",
      "ok forge-proxy-northwind-v1 POST /v2/charges -> outside northwind-pay",
      // ${NOTIFY_URL}: resolved through forge-deploy-config's ConfigMap (J0).
      "ok forge-accounts POST /notifications -> forge-notifications",
      // The starter's service id audit-gw names nothing here: a guess by path, and wrong.
      "-- forge-accounts POST /events -> forge-notifications (joined-by-path)",
      "-- forge-payments GET /limits/{id} -> asked (ambiguous)",
      "ok forge-payments POST /accounts/{id}/debits -> forge-accounts",
      "ok forge-payments POST /forge/northwind/v1/charges -> forge-proxy-northwind-v1",
      "ok forge-payments POST /notifications -> forge-notifications",
      "ok forge-cards GET /accounts/{id} -> forge-accounts (joined-by-path)",
      "-- forge-cards GET /ping -> unlinked",
      "ok forge-notifications GET /accounts/{id} -> forge-accounts (joined-by-label)",
      "ok forge-notifications POST /v1/messages -> outside lantern-mail",
      // ${FORGE_SSO_URL}: set for every service in the platform chart; its host is Forge SSO's alias.
      "ok forge-starter POST /oauth2/token -> outside forge-sso",
    ]);
  });

  it("counts a join by a platform-wide setting as a guess, as a join by path is (J0)", () => {
    // ${NOTIFY_URL}'s setting with no target: no longer aimed at accounts-api, so read as the
    // platform's, for every service, and the link it gives is a guess.
    const repos = all().map((r) =>
      r.repo === "forge-deploy-config"
        ? {
            ...r,
            facts: r.facts.map((f) =>
              f.id === "config.notify-url" ? ({ ...f, target: undefined } as Fact) : f,
            ),
          }
        : r,
    );
    const before = measureLinks({ op, repos: all(), reference: reference() });
    const m = measureLinks({ op, repos, reference: reference() });
    const row = m.calls.find(
      (c) => c.repo === "forge-accounts" && c.call === "POST /notifications",
    )!;
    expect(row.got).toMatchObject({
      kind: "joined",
      repo: "forge-notifications",
      inferred: "joined-by-platform-setting",
    });
    expect(m.links.inferred.joined).toBe(before.links.inferred.joined + 1);
    expect(m.links.inferred.right).toBe(before.links.inferred.right + 1);
  });

  it("counts a person's answers: one naming a repo joins, one naming an outside system takes the call out", () => {
    const m = measureLinks({
      op,
      repos: all(),
      reference: reference(),
      targets: {
        "forge-payments": { "call.get.limits-id": "forge-cards" },
        "forge-accounts": { "call.post.events": "harbor-audit" },
      },
    });
    expect(m.links).toMatchObject({
      joined: 11,
      right: 11,
      precision: 1,
      recall: 0.846,
      asked: 0,
      inferred: { joined: 2, right: 2 },
      outside: { want: 4, got: 4, right: 4 },
    });
  });

  it("an answer of None of these leaves the call unlinked", () => {
    const m = measureLinks({
      op,
      repos: all(),
      reference: reference(),
      targets: { "forge-accounts": { "call.post.events": NO_TARGET } },
    });
    const row = m.calls.find((c) => c.repo === "forge-accounts" && c.call === "POST /events")!;
    expect(row.got).toEqual({ kind: "unlinked" });
    expect(m.links).toMatchObject({ joined: 10, right: 10, precision: 1 });
  });

  it("scores only the repos and calls the reference lists, and says what it can't find", () => {
    const m = measureLinks({
      op,
      repos: all(),
      reference: {
        repos: [
          {
            repo: "forge-cards",
            entries: [{ entry: "GET /limits/{id}" }, { entry: "GET /cards/{id}/status" }],
            calls: [{ call: "GET /accounts/{id}", want: { repo: "forge-accounts" } }],
          },
          { repo: "forge-ledger", entries: [], calls: [] },
        ],
      },
    });
    expect(m.reading).toEqual({
      entries: { want: 2, found: 1 },
      calls: { want: 1, found: 1 },
      missed: ["forge-cards entry GET /cards/{id}/status"],
    });
    expect(m.links).toMatchObject({ want: 1, joined: 1, right: 1, precision: 1, recall: 1 });
    expect(m.notes).toEqual([
      "forge-ledger: no verified facts in the estate, so nothing of it is found (atticus map forge-ledger, then atticus verify forge-ledger).",
    ]);
  });

  it("names a reached component by its repo, and an outside system by its alias", () => {
    const m = measureLinks({
      op,
      repos: all(),
      reference: {
        repos: [
          {
            repo: "forge-notifications",
            entries: [],
            calls: [
              { call: "GET /accounts/{id}", want: { repo: "accounts-api" } },
              { call: "POST /v1/messages", want: { outside: "api.lanternmail.example" } },
            ],
          },
        ],
      },
    });
    expect(m.calls.map((c) => c.right)).toEqual([true, true]);
  });
});

describe("parseLinkReference: the reference file a person writes", () => {
  it("reads the fixture's reference", () => {
    const r = reference();
    expect(r.estate).toBe("forge-bank");
    expect(r.repos).toHaveLength(9);
    expect(r.repos[0]!.calls[0]).toEqual({
      call: "GET /forge/accounts/v1/accounts/{id}",
      at: "src/main/java/forge/portal/AccountsClient.java:16",
      want: { repo: "forge-accounts" },
    });
  });

  it("refuses a call with two answers or none, or nothing to find it by, saying where", () => {
    const r = parseLinkReference(
      [
        "repos:",
        "  - repo: forge-cards",
        "    calls:",
        "      - { call: GET /x, reaches: forge-accounts, outside: lantern-mail }",
        "      - { call: GET /y }",
        "      - { reaches: forge-accounts }",
        "      - { call: GET /z, at: CardsController.java, reaches: forge-cards }",
      ].join("\n"),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues).toEqual([
      "repos.0.calls.0: give one of reaches (a repo, or none) and outside (a system), not both",
      "repos.0.calls.1: give one of reaches (a repo, or none) and outside (a system)",
      "repos.0.calls.2: give the call (METHOD /path), its line (at: file:line) or its fact id",
      "repos.0.calls.3.at: at is file:line, e.g. src/main/java/Client.java:16",
    ]);
  });

  it("reads reaches: none as no link", () => {
    const r = parseLinkReference(
      "repos:\n  - repo: forge-cards\n    calls:\n      - { call: GET /ping, reaches: none }\n",
    );
    expect(r.ok && r.reference.repos[0]!.calls[0]!.want).toEqual({ none: true });
  });
});
