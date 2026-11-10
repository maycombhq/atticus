import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import type { FactsView } from "../src/app/evidence.js";
import {
  dependencyCorrection,
  dependencyFactsOf,
  whatMoved,
} from "../src/screens/architecture/links.js";
import { canvasGraph, linkCounts, type Views } from "../src/screens/architecture/model.js";
import { LinkKinds } from "../src/screens/architecture/Tools.js";
import {
  AlsoLine,
  DependencyWrongForm,
  JoinView,
  WhyLinked,
} from "../src/screens/architecture/WhyLinked.js";

/**
 * ADR 0192: a build dependency on a library of the estate's own is drawn as "depends on", apart
 * from the calls (its own label and line, never in their counts), explained by its coordinates and
 * the lines at both ends, and corrected like every arrow (This link is wrong marks the dependency
 * fact wrong). Beta.24 review: a verified link says the guesses its other calls rest on, "also".
 */

const W = COPY.why;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string | undefined) =>
  (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const DEP: Api.HierJoinT = {
  interface: "depends-on:forge-wallets/wallets-api>forge-payments-common/payments-common",
  from: "wallets-api",
  to: "payments-common",
  how: "coordinates",
  gateway: false,
  verified: true,
  caller: [
    { source: "code", repo: "forge-wallets", at: "wallets-api/pom.xml:13" },
    { source: "code", repo: "forge-wallets", at: "wallets-api/pom.xml:12" },
  ],
  callee: [
    { source: "code", repo: "forge-payments-common", at: "pom.xml:10" },
    { source: "code", repo: "forge-payments-common", at: "pom.xml:9" },
  ],
  hops: [],
  other: [],
  dependency: { group: "forge.payments", name: "forge-payments-common" },
};
const CALL_JOIN: Api.HierJoinT = {
  interface: "if-0f06d434a34c81c9",
  from: "wallets-api",
  to: "accounts-api",
  how: "host",
  gateway: false,
  verified: true,
  also: ["path", "platform-setting"],
  method: "GET",
  path: "/accounts/{}",
  caller: [{ source: "code", repo: "forge-wallets", at: "src/Accounts.java:8" }],
  callee: [{ source: "code", repo: "forge-accounts", at: "src/AccountsController.java:12" }],
  hops: [],
  other: [],
};
const node = (id: string, kind: string, label: string): Api.HierNodeT => ({
  id,
  kind: kind as Api.HierNodeT["kind"],
  label,
  childCount: 0,
  state: "current",
  gaps: [],
  evidence: [],
  properties: {},
});
const edge = (type: Api.HierEdgeT["type"], to: string, joins: Api.HierJoinT[]): Api.HierEdgeT => ({
  id: `${type}:system:wallets>${to}`,
  from: "system:wallets",
  to,
  type,
  count: joins.length,
  state: "current",
  gaps: [],
  evidence: [],
  joins,
});
const DEP_EDGE = edge("depends-on", "system:payments", [DEP]);
const CALL_EDGE = edge("calls", "system:accounts", [CALL_JOIN]);
const views = (edges: Api.HierEdgeT[]): Views =>
  new Map([
    [
      "estate",
      {
        lens: "architecture",
        node: node("estate", "estate", "Estate"),
        path: [],
        children: [
          node("system:wallets", "system", "Wallets"),
          node("system:payments", "system", "Payments"),
          node("system:accounts", "system", "Accounts"),
        ],
        outside: [],
        edges,
        reduced: true,
        hiddenEdges: 0,
      },
    ],
  ]);
const DEP_FACT: Api.FactCiteViewT = {
  id: "dependency.wallets-api.forge-payments-common",
  kind: "dependency",
  label: "builds on forge.payments:forge-payments-common",
  claim: { group: "forge.payments", name: "forge-payments-common", value: "forge-payments-common" },
  cite: { file: "wallets-api/pom.xml", line: 13, value: "forge-payments-common" },
  verified: "line",
  by: "assistant",
};
const FACTS: FactsView = {
  repo: "forge-wallets",
  file: "facts/forge-wallets.jsonl",
  present: true,
  facts: [DEP_FACT],
  corrections: { file: "facts/forge-wallets.corrections.jsonl", count: 0, stale: [] },
  questions: [],
  verify: "atticus verify forge-wallets",
  problems: [],
};

describe("depends-on on the canvas (ADR 0192)", () => {
  const g = canvasGraph(views([DEP_EDGE, CALL_EDGE]), "estate", new Set());

  it("labels a dependency in words and marks it apart from the calls", () => {
    const dep = g.links.find((l) => l.type === "depends-on")!;
    expect(dep.label).toBe(W.dependency.edge);
    expect(dep.dependency).toBe(true);
    expect(dep.async).toBe(false);
    const call = g.links.find((l) => l.type === "calls")!;
    expect(call.label).toBe("calls");
    expect(call.dependency).toBeUndefined();
  });

  it("never counts a dependency with the links' calls, and says it apart in the legend", () => {
    const out = html(<LinkKinds links={g.links} />);
    expect(linkCounts(g.links.filter((l) => !l.dependency))).toEqual({
      fromCode: 1,
      byPerson: 0,
      byAi: 0,
    });
    expect(out).toContain(esc(COPY.canvasAi.legendDependency(1)));
  });
});

describe("why a dependency is linked (ADR 0192)", () => {
  it("says the coordinates, that it is a build dependency, and the lines at both ends", () => {
    const out = html(<WhyLinked link={DEP_EDGE} />);
    expect(out).toContain(esc(W.dependency.intro));
    expect(out).toContain(
      esc(
        W.dependency.title(
          "wallets-api",
          "payments-common",
          "forge.payments:forge-payments-common",
        ),
      ),
    );
    expect(out).toContain(esc(W.how.coordinates));
    expect(out).toContain(esc(W.dependency.caller));
    expect(out).toContain(esc(W.dependency.callee));
    expect(out).toContain("wallets-api/pom.xml:13");
    expect(out).toContain("pom.xml:10");
    // never the call's words
    expect(out).not.toContain(esc(W.caller));
    expect(out).not.toContain(esc(W.intro));
  });

  it("finds the dependency fact on the build file's line, and marks it wrong only with why", () => {
    expect(dependencyFactsOf(DEP, FACTS).map((f) => f.id)).toEqual([
      "dependency.wallets-api.forge-payments-common",
    ]);
    expect(dependencyFactsOf(CALL_JOIN, FACTS)).toEqual([]);
    expect(dependencyCorrection(DEP_FACT, "  ")).toEqual({ error: "needReason" });
    expect(dependencyCorrection(DEP_FACT, "a test helper")).toEqual({
      body: {
        fact: "dependency.wallets-api.forge-payments-common",
        action: "wrong",
        reason: "a test helper",
      },
    });
  });

  it("renders This link is wrong on a dependency: loading, error, nothing to correct, the form, done", () => {
    const close = () => undefined;
    expect(
      html(<DependencyWrongForm join={DEP} facts={{ state: "loading" }} onClose={close} />),
    ).toContain(esc(W.dependency.loadingFacts));
    expect(
      html(
        <DependencyWrongForm
          join={DEP}
          facts={{ state: "error", error: "boom" }}
          onClose={close}
        />,
      ),
    ).toContain(esc(W.dependency.factsFailed("boom")));
    const empty = { ...FACTS, facts: [] };
    expect(
      html(
        <DependencyWrongForm join={DEP} facts={{ state: "ready", data: empty }} onClose={close} />,
      ),
    ).toContain(esc(W.dependency.noFact("forge-wallets")));
    const form = html(
      <DependencyWrongForm join={DEP} facts={{ state: "ready", data: FACTS }} onClose={close} />,
    );
    expect(form).toContain(esc(W.dependency.reason));
    expect(form).toContain(esc(DEP_FACT.label));
    const done = html(
      <DependencyWrongForm
        join={DEP}
        facts={{ state: "ready", data: FACTS }}
        onClose={close}
        saving={{
          state: "done",
          will: { kind: "dropped", from: "wallets-api", was: "payments-common" },
          result: {
            correction: {
              schemaVersion: 1,
              fact: DEP_FACT.id,
              target: {
                kind: "dependency",
                file: "wallets-api/pom.xml",
                line: 13,
                value: "forge-payments-common",
              },
              action: "wrong",
              reason: "a test helper",
              by: "pat",
              at: "2026-11-10T10:00:00Z",
            },
            file: "facts/forge-wallets.corrections.jsonl",
            commit: "git add facts/forge-wallets.corrections.jsonl",
            verify: "atticus verify forge-wallets",
          },
        }}
      />,
    );
    expect(done).toContain(esc(W.dependency.will("wallets-api", "payments-common")));
  });

  it("watches a corrected dependency's line move off its link when the estate is joined again", () => {
    const moved = whatMoved(views([DEP_EDGE]), views([]), ["forge-wallets:wallets-api/pom.xml:13"]);
    expect(moved).toEqual([
      {
        call: "forge-wallets:wallets-api/pom.xml:13",
        what: "forge.payments:forge-payments-common",
        was: "wallets-api → payments-common",
      },
    ]);
  });
});

describe("also: the guesses a verified link's other calls rest on (beta.24 review)", () => {
  it("says them in words, apart from how the link was made", () => {
    const out = html(<JoinView join={CALL_JOIN} />);
    expect(out).toContain(esc(W.how.host));
    expect(out).toContain(esc(W.also(`${W.alsoHow.path}, ${W.alsoHow["platform-setting"]}`)));
  });

  it("says nothing with none, and nothing on a link that isn't verified", () => {
    expect(html(<AlsoLine also={undefined} />)).toBe("");
    expect(html(<AlsoLine also={[]} />)).toBe("");
    const out = html(<JoinView join={{ ...CALL_JOIN, verified: false }} />);
    expect(out).not.toContain(esc(W.also(`${W.alsoHow.path}, ${W.alsoHow["platform-setting"]}`)));
  });
});
