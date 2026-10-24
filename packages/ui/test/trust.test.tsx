import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { screenOf, tabsOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { commitWords, TrustPage, TrustRow, trustWhy } from "../src/screens/map/Trust.js";

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
    expect(out).toContain(esc(T.unknownFiles(2)));
    expect(out).toContain("src/a.ts");
    expect(out).toContain("/atticus-map forge-ledger");
    expect(out).toContain("atticus map forge-ledger");
    expect(out).toContain('aria-labelledby="trust-forge-ledger"');
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
