import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import type { FactsView } from "../src/app/evidence.js";
import {
  dependencyBatch,
  dependencyCorrections,
  joinWhat,
  linkDependenciesOf,
} from "../src/screens/architecture/links.js";
import {
  DependencyView,
  DependencyWrongForm,
  saveDependencyBatch,
} from "../src/screens/architecture/WhyLinked.js";
import { EveryDependencyView } from "../src/screens/architecture/EveryDependency.js";

/**
 * Beta.25 review of ADR 0192: This link is wrong on a "depends on" arrow lists every dependency
 * fact the link rests on (C4 3.11.0's `dependency.facts`), each chosen at first, so marking them
 * wrong takes the arrow away rather than leaving it on another line; and an arrow merged from more
 * dependencies than its view lists reads the rest. Invented Forge names only.
 */
const D = COPY.why.dependency;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const fact = (id: string, line: number): Api.FactCiteViewT => ({
  id,
  kind: "dependency",
  label: `builds on forge.payments:forge-payments-common (${id})`,
  claim: { group: "forge.payments", name: "forge-payments-common", value: "forge-payments-common" },
  cite: { file: "wallets-api/pom.xml", line, value: "forge-payments-common" },
  verified: "line",
  by: "assistant",
});
const JOIN: Api.HierJoinT = {
  interface: "depends-on:forge-wallets/wallets-api>forge-payments-common/payments-common",
  from: "wallets-api",
  to: "payments-common",
  how: "coordinates",
  gateway: false,
  verified: true,
  caller: [
    { source: "code", repo: "forge-wallets", at: "wallets-api/pom.xml:13" },
    { source: "code", repo: "forge-wallets", at: "wallets-api/pom.xml:31" },
  ],
  callee: [{ source: "code", repo: "forge-payments-common", at: "pom.xml:10" }],
  hops: [],
  other: [],
  dependency: {
    group: "forge.payments",
    name: "forge-payments-common",
    facts: [
      { repo: "forge-wallets", fact: "dependency.a", at: "wallets-api/pom.xml:13", lines: [] },
      { repo: "forge-wallets", fact: "dependency.b", at: "wallets-api/pom.xml:31", lines: [] },
    ],
  },
};
const FACTS: FactsView = {
  repo: "forge-wallets",
  file: "facts/forge-wallets.jsonl",
  present: true,
  facts: [fact("dependency.a", 13), fact("dependency.b", 31)],
  corrections: { file: "facts/forge-wallets.corrections.jsonl", count: 0, stale: [] },
  questions: [],
  verify: "atticus verify forge-wallets",
  problems: [],
};

describe("This link is wrong on a dependency that rests on several lines (beta.25)", () => {
  it("lists every dependency fact on the link, with its fact when the facts are read", () => {
    const deps = linkDependenciesOf(JOIN, FACTS);
    expect(deps.map((d) => [d.id, d.at, d.fact?.id])).toEqual([
      ["dependency.a", "wallets-api/pom.xml:13", "dependency.a"],
      ["dependency.b", "wallets-api/pom.xml:31", "dependency.b"],
    ]);
    // a join from before 3.11.0: the facts on its first line
    const { facts: _f, ...older } = JOIN.dependency!;
    expect(linkDependenciesOf({ ...JOIN, dependency: older }, FACTS).map((d) => d.id)).toEqual([
      "dependency.a",
    ]);
  });

  it("marks each chosen one wrong, with why, and asks for one at least", () => {
    expect(
      dependencyCorrections([{ id: "dependency.a" }, { id: "dependency.b" }], "a fork"),
    ).toEqual({
      bodies: [
        { fact: "dependency.a", action: "wrong", reason: "a fork" },
        { fact: "dependency.b", action: "wrong", reason: "a fork" },
      ],
    });
    expect(dependencyCorrections([], "a fork")).toEqual({ error: "needFact" });
    expect(dependencyCorrections([{ id: "dependency.a" }], " ")).toEqual({ error: "needReason" });
  });

  it("renders a choice of every line, each chosen at first", () => {
    const out = html(
      <DependencyWrongForm
        join={JOIN}
        facts={{ state: "ready", data: FACTS }}
        onClose={() => undefined}
      />,
    );
    expect(out).toContain(esc(D.pickFacts(2)));
    expect(out.match(/type="checkbox" checked=""/g)).toHaveLength(2);
    expect(out).toContain("wallets-api/pom.xml:31");
  });
});

describe("This link is wrong in one batch, every coordinate shown (review of beta.25)", () => {
  // component kit publishes kit-api and kit-core; wallets-api builds on both: one link
  const KIT: Api.HierJoinT = {
    ...JOIN,
    interface: "depends-on:forge-wallets/wallets-api>forge-kit/kit",
    to: "kit",
    dependency: {
      group: "forge.kit",
      name: "kit-api",
      facts: [
        {
          repo: "forge-wallets",
          fact: "dependency.a",
          at: "wallets-api/pom.xml:13",
          lines: [],
          group: "forge.kit",
          name: "kit-api",
        },
        {
          repo: "forge-wallets",
          fact: "dependency.b",
          at: "wallets-api/pom.xml:31",
          lines: [],
          group: "forge.kit",
          name: "kit-core",
        },
      ],
    },
  };
  const will = { kind: "dropped", from: "wallets-api", was: "kit" } as const;

  it("shows each fact with the coordinates it names, and the link's every coordinate", () => {
    expect(linkDependenciesOf(KIT, FACTS).map((d) => d.coordinates)).toEqual([
      "forge.kit:kit-api",
      "forge.kit:kit-core",
    ]);
    expect(joinWhat(KIT)).toBe("forge.kit:kit-api, forge.kit:kit-core");
    const out = html(
      <DependencyWrongForm join={KIT} facts={{ state: "ready", data: FACTS }} onClose={() => {}} />,
    );
    expect(out).toContain("forge.kit:kit-core");
  });

  it("heads the link with a scope only when every fact on it has that scope", () => {
    const scoped = (a?: string, b?: string, link?: string): Api.HierJoinT => ({
      ...KIT,
      dependency: {
        ...KIT.dependency!,
        ...(link ? { scope: link } : {}),
        facts: KIT.dependency!.facts!.map((f, i) => {
          const s = i === 0 ? a : b;
          return s ? { ...f, scope: s } : f;
        }),
      },
    });
    const head = (j: Api.HierJoinT) => html(<DependencyView join={j} />);
    const runtime = esc(D.scope("runtime"));
    // compile kit-api, runtime kit-core: no scope in the head (the join says none)
    expect(head(scoped(undefined, "runtime"))).not.toContain("li-scope");
    // nor when an older server gave the first fact's scope to the whole link
    expect(head(scoped("runtime", undefined, "runtime"))).not.toContain("li-scope");
    expect(head(scoped("runtime", "provided", "runtime"))).not.toContain(runtime);
    // both runtime: the link is runtime
    expect(head(scoped("runtime", "runtime", "runtime"))).toContain(runtime);
    // one fact, its scope
    const one: Api.HierJoinT = {
      ...JOIN,
      dependency: {
        ...JOIN.dependency!,
        scope: "provided",
        facts: [{ ...JOIN.dependency!.facts![0]!, scope: "provided" }],
      },
    };
    expect(head(one)).toContain(esc(D.scope("provided")));
  });

  it("asks for all of them in one POST /api/links/corrections, all or none", async () => {
    const b = dependencyBatch(linkDependenciesOf(KIT, FACTS), " a fork ");
    expect(b).toEqual({
      body: {
        items: [
          { repo: "forge-wallets", fact: "dependency.a", action: "wrong" },
          { repo: "forge-wallets", fact: "dependency.b", action: "wrong" },
        ],
        reason: "a fork",
      },
    });
    if (!("body" in b)) return;
    const posted: string[] = [];
    const ok = await saveDependencyBatch(
      async (path) => {
        posted.push(path);
        return {
          files: [
            {
              repo: "forge-wallets",
              file: "facts/forge-wallets.corrections.jsonl",
              lines: ["{}", "{}"],
              corrections: [],
            },
          ],
          commit: "git add facts/forge-wallets.corrections.jsonl",
          verify: ["atticus verify forge-wallets"],
        };
      },
      b.body,
      will,
    );
    expect(posted).toEqual(["/api/links/corrections"]);
    expect(ok.state).toBe("done-all");
    // a failure is one error and nothing said written: the route wrote none of it
    const failed = await saveDependencyBatch(
      async () => {
        posted.push("again");
        throw new Error("Atticus wrote none of it");
      },
      b.body,
      will,
    );
    expect(posted).toEqual(["/api/links/corrections", "again"]);
    expect(failed).toEqual({ state: "error", text: "Atticus wrote none of it" });
    const shown = html(
      <DependencyWrongForm
        join={KIT}
        facts={{ state: "ready", data: FACTS }}
        saving={failed}
        onClose={() => {}}
      />,
    );
    expect(shown).toContain("Atticus wrote none of it");
    expect(shown).not.toContain(esc(D.savedAll(2, "facts/forge-wallets.corrections.jsonl")));
    const done = html(
      <DependencyWrongForm
        join={KIT}
        facts={{ state: "ready", data: FACTS }}
        saving={ok}
        onClose={() => {}}
      />,
    );
    expect(done).toContain(esc(D.savedAll(2, "facts/forge-wallets.corrections.jsonl")));
  });
});

describe("every dependency on a merged arrow (beta.25)", () => {
  const edge: Api.HierEdgeT = {
    id: "depends-on:system:wallets>system:payments",
    from: "system:wallets",
    to: "system:payments",
    type: "depends-on",
    count: 2,
    state: "current",
    gaps: [],
    evidence: [],
    joins: [JOIN],
  };
  const other: Api.HierJoinT = {
    ...JOIN,
    interface: "depends-on:forge-wallets/wallets-batch>forge-payments-common/payments-common",
    from: "wallets-batch",
  };

  it("says it is reading, or that it couldn't", () => {
    expect(html(<EveryDependencyView link={edge} every={{ state: "loading" }} />)).toContain(
      esc(D.moreLoading),
    );
    expect(
      html(<EveryDependencyView link={edge} every={{ state: "error", error: "boom" }} />),
    ).toContain(esc(D.moreFailed("boom")));
  });

  it("shows the dependencies the view didn't list, each with what goes under it", () => {
    const out = html(
      <EveryDependencyView
        link={edge}
        every={{ state: "ready", data: { edge: edge.id, count: 2, joins: [JOIN, other] } }}
        under={(j) => <span>{`under ${j.from}`}</span>}
      />,
    );
    expect(out).toContain("under wallets-batch");
    expect(out).not.toContain("under wallets-api");
    expect(
      html(
        <EveryDependencyView
          link={edge}
          every={{ state: "ready", data: { edge: edge.id, count: 1, joins: [JOIN] } }}
        />,
      ),
    ).toBe("");
  });
});
