import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { screenOf, tabsOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import {
  commitWords,
  FreshPanel,
  RepoFactsList,
  TrustPage,
  TrustRow,
  trustWhy,
} from "../src/screens/map/Trust.js";

/** Map › Trust (ADR 0124): how far to trust each repo's map, from the verifier's report. */

const T = COPY.trust;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const SHA = "0123abc" + "0".repeat(33);

const LEDGER: Api.TrustRepoT = {
  repo: "forge-ledger",
  facts: {
    path: "facts/forge-ledger.jsonl",
    present: true,
    count: 40,
    unverified: 0,
    commit: "0123abc",
  },
  verify: {
    path: "facts/forge-ledger.verify.yaml",
    report: {
      accepted: 38,
      rejected: 0,
      redacted: 1,
      coverage: { ratio: 0.8, read: 8, unknown: 2, excluded: 1 },
      unknownFiles: ["src/a.ts", "src/b.ts"],
      commit: "0123abc",
    },
  },
  checkout: { path: "workspace/forge-ledger", present: true, commit: SHA },
  sameCommit: true,
  catalog: { from: "facts", fromFacts: 31, fromReaders: 0 },
  state: "unknown-files",
  next: { command: "atticus map forge-ledger", slash: "/atticus-map forge-ledger" },
};
const GATEWAY: Api.TrustRepoT = {
  repo: "forge-gateway",
  facts: { path: "facts/forge-gateway.jsonl", present: false, count: 0, unverified: 0 },
  verify: { path: "facts/forge-gateway.verify.yaml", report: null },
  checkout: { path: "workspace/forge-gateway", present: false },
  sameCommit: null,
  catalog: { from: "readers", fromFacts: 0, fromReaders: 4 },
  state: "not-read",
  next: { command: "atticus map forge-gateway", slash: "/atticus-map forge-gateway" },
};

describe("Map › Trust (ADR 0124)", () => {
  it("is a tab of Map", () => {
    expect(screenOf("trust").section).toBe("Map");
    expect(tabsOf("Map").map((t) => t.id)).toContain("trust");
  });

  it("shows a repo's facts kept and rejected, coverage, files not read, commit, catalog and the next command", () => {
    const out = renderToStaticMarkup(<TrustRow r={LEDGER} />);
    expect(out).toContain(esc(T.states["unknown-files"]!));
    expect(out).toContain(esc(T.why.unknownFiles(2, "forge-ledger")));
    expect(out).toContain(">38");
    expect(out).toContain(esc(T.redacted(1)));
    expect(out).toContain(esc(T.coverageOf(0.8, 8, 2, 1)));
    expect(out).toContain("80%");
    expect(out).toContain(esc(T.sameCommit("0123abc")));
    expect(out).toContain(esc(T.from.facts!));
    expect(out).toContain(esc(T.records(31, 0)));
    expect(out).toContain(esc(T.show(2, T.what.unknown!)));
    expect(out).toContain("src/a.ts");
    expect(out).toContain("/atticus-map forge-ledger");
    expect(out).toContain("atticus map forge-ledger");
    expect(out).toContain('aria-labelledby="trust-forge-ledger"');
  });

  // ADR 0124 addendum A-framework: what each repo is built on, across the estate.
  it("says what a repo is built on, with the module and where, and the patterns it shows none of", () => {
    const out = renderToStaticMarkup(
      <TrustRow
        r={{
          ...LEDGER,
          frameworks: [
            { name: "spring-boot", version: "3.3.4", cite: "pom.xml:6" },
            {
              name: "forge-web-starter",
              version: "2.8.1",
              component: "ledger-web",
              cite: "web/pom.xml:17",
            },
            { name: "react", cite: "package.json:6", gap: "Were its screens missed?" },
          ],
        }}
      />,
    );
    expect(out).toContain(esc(T.builtOn));
    expect(out).toContain(esc(T.builtOnOne("spring-boot", "3.3.4", "pom.xml:6")));
    expect(out).toContain(
      esc(
        T.builtOnModule(T.builtOnOne("forge-web-starter", "2.8.1", "web/pom.xml:17"), "ledger-web"),
      ),
    );
    expect(out).toContain(esc(T.builtOnGap("react")));
    expect(out).toContain(esc("Were its screens missed?"));
  });

  // ADR 0163: the organisation's terms the repo writes, each with its role and its line.
  it("lists a repo's terms with the role a note gave each, and says none when there are none", () => {
    const out = renderToStaticMarkup(
      <TrustRow
        r={{
          ...LEDGER,
          terms: [
            {
              term: "appId",
              value: "APP000456",
              role: "owner",
              cite: "forge-app.yaml:2",
              meaning: "forge-app.yaml:1",
              note: "28ba1b42",
            },
            { term: "cmdb", value: "APP000123", role: "unknown", cite: "userAccess.json:4" },
          ],
        }}
      />,
    );
    expect(out).toContain(esc(T.terms));
    expect(out).toContain(
      esc(
        `${T.termOne("appId", "APP000456", T.termRole.owner!, "forge-app.yaml:2")}; note 28ba1b42`,
      ),
    );
    expect(out).toContain(
      esc(T.termOne("cmdb", "APP000123", T.termRole.unknown!, "userAccess.json:4")),
    );
    expect(out).toContain('aria-label="Terms: forge-ledger"');
    expect(renderToStaticMarkup(<TrustRow r={LEDGER} />)).toContain(esc(T.termsNone));
  });

  // ADR 0148 (P3): the sample audit's precision, with the size and the range.
  it("says a sample audit's precision for facts and links, how small it is, or how to start one", () => {
    const tally = (right: number, wrong: number, precision: number | null) => ({
      drawn: right + wrong,
      right,
      wrong,
      unsure: 0,
      open: 0,
      gone: 0,
      precision,
      low: precision === null ? null : 0.4,
      high: precision === null ? null : 0.98,
    });
    const audit = {
      path: "facts/forge-ledger.audit.yaml",
      facts: tally(9, 1, 0.9),
      byKind: {},
      links: tally(0, 0, null),
    };
    const out = renderToStaticMarkup(<TrustRow r={{ ...LEDGER, audit }} />);
    expect(out).toContain(esc(T.audit));
    expect(out).toContain(esc(T.auditTally(T.auditFacts, audit.facts)));
    expect(out).toContain(esc("facts: 90% right (9 of 10; 95% between 40% and 98%)"));
    expect(out).toContain(esc("links: no answers yet"));
    expect(out).toContain(esc(T.auditSmall));
    const none = renderToStaticMarkup(<TrustRow r={LEDGER} />);
    expect(none).toContain(esc(T.auditNone("forge-ledger")));
  });

  it("says a repo nobody has read yet is built on nothing it knows of, and guesses nothing", () => {
    const out = renderToStaticMarkup(<TrustRow r={GATEWAY} />);
    expect(out).toContain(esc(T.builtOnNone));
    expect(out).not.toContain(esc(T.builtOnGap("react")));
  });

  it("says a repo not read yet is mapped by the readers, with no report", () => {
    const out = renderToStaticMarkup(<TrustRow r={GATEWAY} />);
    expect(out).toContain(esc(T.why.notRead));
    expect(out).toContain(esc(T.noReport));
    expect(out).toContain(esc(T.noFactsCommit));
    expect(out).toContain(esc(T.from.readers!));
  });

  it("says a stale read's two commits, a rejected read's count and a trusted one's", () => {
    const stale = {
      ...LEDGER,
      sameCommit: false,
      checkout: { ...LEDGER.checkout, commit: "fedcba9" + "1".repeat(33) },
      state: "stale" as const,
    };
    expect(trustWhy(stale)).toBe(T.why.stale("0123abc", "fedcba9"));
    expect(commitWords(stale)).toBe(T.otherCommit("0123abc", "fedcba9"));
    const rejected = {
      ...LEDGER,
      verify: { ...LEDGER.verify, report: { ...LEDGER.verify.report!, rejected: 3 } },
      state: "rejected" as const,
    };
    expect(trustWhy(rejected)).toBe(T.why.rejected(3));
    expect(commitWords({ ...LEDGER, checkout: { path: "x", present: false } })).toBe(
      T.noCheckout("0123abc"),
    );
    const { next: _n, ...rest } = LEDGER;
    const trusted = renderToStaticMarkup(<TrustRow r={{ ...rest, state: "trusted" }} />);
    expect(trusted).toContain(esc(T.why.trusted));
    expect(trusted).toContain("chip done");
  });

  it("has loading, error and empty states, and lists files it couldn't read", () => {
    expect(renderToStaticMarkup(<TrustPage of={{ state: "loading" }} />)).toContain(
      'aria-busy="true"',
    );
    expect(renderToStaticMarkup(<TrustPage of={{ state: "error", error: "boom" }} />)).toContain(
      'role="alert"',
    );
    const empty = renderToStaticMarkup(
      <TrustPage of={{ state: "ready", data: { factsDir: "facts", repos: [], problems: [] } }} />,
    );
    expect(empty).toContain(esc(T.empty));
    const page = renderToStaticMarkup(
      <TrustPage
        of={{
          state: "ready",
          data: {
            factsDir: "facts",
            repos: [LEDGER, GATEWAY],
            problems: [{ file: "facts/forge-infra.verify.yaml", message: "can't read YAML" }],
          },
        }}
      />,
    );
    expect(page).toContain(esc(T.summary(0, 2)));
    expect(page).toContain("facts/forge-infra.verify.yaml");
    expect(page).toContain(esc(T.reportIn("facts")));
  });
});

describe("Map › Trust: every count opens its list (ADR 0135, C3)", () => {
  const EVENTS: Api.TrustRepoT = {
    ...LEDGER,
    repo: "forge-events",
    facts: { ...LEDGER.facts, path: "facts/forge-events.jsonl", unverified: 1 },
    verify: {
      path: "facts/forge-events.verify.yaml",
      report: {
        ...LEDGER.verify.report!,
        rejected: 1,
        coverage: { ratio: 0.9, read: 9, unknown: 1, excluded: 1 },
        unknownFiles: ["src/Late.java"],
      },
    },
    state: "rejected",
    lists: {
      rejected: [
        {
          fact: "e-post-entry",
          kind: "entry",
          file: "src/EntryController.java",
          line: 22,
          code: "claim-not-on-line",
          message: "line 22 doesn't say /entries",
        },
        { code: "bad-question", message: "no options" },
      ],
      excluded: ["generated/client.ts"],
      asked: [{ id: "q-0123456789ab", question: "Which ledger?", lines: ["src/Job.java:9"] }],
      unverified: [{ fact: "c-notify", kind: "call", file: "src/Notifier.java", line: 9 }],
    },
  };

  it("opens each count's list, with file and line and the action that closes each", () => {
    const out = renderToStaticMarkup(<TrustRow r={EVENTS} />);
    // Rejected: every line of the rejected file, where, and how it is fixed.
    expect(out).toContain(esc(T.show(2, T.what.rejected!)));
    expect(out).toContain("src/EntryController.java:22");
    expect(out).toContain(esc(T.rejectedLine("claim-not-on-line", "line 22 doesn't say /entries")));
    expect(out).toContain(esc(T.rejectedNoLine));
    expect(out).toContain(esc(T.rejectedFix("facts/forge-events.rejected.jsonl")));
    expect(out).toContain("/atticus-map forge-events");
    // The one file not read: where it is, and what reads it.
    expect(out).toContain(esc(T.show(1, T.what.unknown!)));
    expect(out).toContain("src/Late.java");
    expect(out).toContain(esc(T.unknownFix("forge-events")));
    // Excluded, asked and not checked.
    expect(out).toContain("generated/client.ts");
    expect(out).toContain(esc(T.excludedFix("forge-events")));
    expect(out).toContain("Which ledger?");
    expect(out).toContain('href="#/questions/q-0123456789ab"');
    expect(out).toContain("src/Notifier.java:9");
    expect(out).toContain("atticus verify forge-events");
    // Kept and redacted open the repo's facts; the records open the repo on the canvas.
    expect(out).toContain(esc(T.show(38, T.what.kept!)));
    expect(out).toContain(esc(T.show(1, T.what.redacted!)));
    expect(out).toContain('href="#/canvas?lens=repo&amp;node=repo%3Aforge-events"');
  });

  it("says a count of nothing is none, and opens nothing", () => {
    const out = renderToStaticMarkup(
      <TrustRow r={{ ...EVENTS, lists: { ...EVENTS.lists!, asked: [] } }} />,
    );
    expect(out).not.toContain(esc(T.show(0, T.what.asked!)));
    expect(out).toContain(T.none);
  });

  it("lists the kept facts, each a citation, with the loading, empty and error states", () => {
    const facts: Api.RepoFactsViewT = {
      repo: "forge-events",
      file: "facts/forge-events.jsonl",
      present: true,
      facts: [
        {
          id: "c-key",
          kind: "config",
          label: "api.key = <redacted>",
          claim: {},
          cite: { file: "src/app.yaml", line: 3, value: "api.key", quote: "api.key: <redacted>" },
          verified: "line",
          by: "assistant",
        },
      ],
      corrections: { file: "facts/forge-events.corrections.jsonl", count: 0, stale: [] },
      questions: [],
      verify: "atticus verify forge-events",
      problems: [],
    };
    const ready = renderToStaticMarkup(
      <RepoFactsList repo="forge-events" of={{ state: "ready", data: facts }} />,
    );
    expect(ready).toContain("app.yaml");
    expect(ready).toContain(esc("api.key = <redacted>"));
    const none = renderToStaticMarkup(
      <RepoFactsList repo="forge-events" of={{ state: "ready", data: facts }} only={() => false} />,
    );
    expect(none).toContain(T.none);
    expect(
      renderToStaticMarkup(<RepoFactsList repo="forge-events" of={{ state: "loading" }} />),
    ).toContain('aria-busy="true"');
    expect(
      renderToStaticMarkup(
        <RepoFactsList repo="forge-events" of={{ state: "error", error: "no such file" }} />,
      ),
    ).toContain("no such file");
  });
});

/** ADR 0141 (P5): the estate's freshness, a section of the Trust tab. */
describe("Map › Trust › Freshness (ADR 0141)", () => {
  const F = T.fresh;
  const repo = (over: Partial<Api.FreshRepoT>): Api.FreshRepoT => ({
    repo: "forge-ledger",
    state: "stale",
    factsFile: "facts/forge-ledger.jsonl",
    facts: 17,
    factsCommits: ["0123abc9999"],
    head: "fedcba98888",
    current: 0,
    carried: 14,
    reread: 3,
    citedChanged: 3,
    changed: 4,
    toRead: 3,
    unknown: [],
    command: "atticus map forge-ledger",
    slash: "/atticus-map forge-ledger",
    ...over,
  });
  /** A fresh repo: nothing to run. */
  const fresh = (name = "forge-ledger"): Api.FreshRepoT => {
    const { command: _c, slash: _s, ...rest } = repo({ repo: name, state: "fresh", reread: 0 });
    return rest;
  };
  const ready = (repos: Api.FreshRepoT[]) => ({
    state: "ready" as const,
    data: { factsDir: "facts", repos, problems: [] },
  });

  it("lists the repos that moved on, most stale first, with their commits, counts and command", () => {
    const out = renderToStaticMarkup(
      <FreshPanel
        of={ready([
          repo({}),
          repo({
            repo: "forge-notify",
            state: "moved",
            reread: 0,
            citedChanged: 0,
            carried: 17,
            command: "atticus verify forge-notify --write",
          }),
          fresh("forge-cards"),
          repo({ repo: "forge-gateway", state: "not-read", facts: 0 }),
        ])}
      />,
    );
    expect(out).toContain(esc(F.summary(2, 3, 3)));
    expect(out).toContain(`<caption class="sr">${esc(F.caption)}</caption>`);
    expect(out).toContain('<th scope="row" class="mono">forge-ledger</th>');
    expect(out.indexOf("forge-ledger")).toBeLessThan(out.indexOf("forge-notify"));
    expect(out).toContain("0123abc");
    expect(out).toContain("fedcba9");
    expect(out).toContain(esc(F.states.stale!));
    expect(out).toContain(esc(F.states.moved!));
    expect(out).toContain("atticus map forge-ledger");
    expect(out).toContain("/atticus-map forge-ledger");
    expect(out).toContain("atticus verify forge-notify --write");
    // The fresh repo is counted, not listed; the unread one neither.
    expect(out).not.toContain(">forge-cards<");
    expect(out).toContain(esc(F.freshCount(1)));
    expect(out).not.toContain("forge-gateway");
  });

  it("says when every repo read is fresh, and has loading, error and empty states", () => {
    expect(renderToStaticMarkup(<FreshPanel of={ready([fresh()])} />)).toContain(
      esc(F.allFresh(1)),
    );
    expect(renderToStaticMarkup(<FreshPanel of={{ state: "loading" }} />)).toContain(
      'aria-busy="true"',
    );
    expect(renderToStaticMarkup(<FreshPanel of={{ state: "error", error: "boom" }} />)).toContain(
      'role="alert"',
    );
    expect(
      renderToStaticMarkup(<FreshPanel of={ready([repo({ state: "not-read", facts: 0 })])} />),
    ).toContain(esc(F.empty));
  });

  it("sits above the repos on the Trust tab when it is given", () => {
    const out = renderToStaticMarkup(
      <TrustPage
        of={{ state: "ready", data: { factsDir: "facts", repos: [LEDGER], problems: [] } }}
        fresh={ready([repo({})])}
      />,
    );
    expect(out.indexOf(esc(F.title))).toBeLessThan(out.indexOf("trust-forge-ledger"));
  });
});
