import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { RunsContext, type Ctx } from "../src/app/copilot-runs.js";
import { COPY } from "../src/copy.js";
import { TrustPage, TrustRepos, TrustRow, trustRepoMatches } from "../src/screens/map/Trust.js";

/**
 * Beta.27 (a user's Map › Trust): a filter box over the repos' sections, by repo, and "Read it
 * again" on every read repo's section, a fresh and fully covered one too (before, only a stale
 * repo or one with rejected or unread files offered it). Rendered as markup at given states.
 */
const T = COPY.trust;
const F = COPY.filter;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const SHA = "0123abc" + "0".repeat(33);

const repo = (id: string, state: Api.TrustRepoT["state"]): Api.TrustRepoT => ({
  repo: id,
  facts: { path: `facts/${id}.jsonl`, present: true, count: 12, unverified: 0, commit: "0123abc" },
  verify: {
    path: `facts/${id}.verify.yaml`,
    report: {
      accepted: 12,
      rejected: 0,
      redacted: 0,
      coverage: { ratio: 1, read: 6, unknown: 0, excluded: 0 },
      unknownFiles: [],
      commit: "0123abc",
    },
  },
  checkout: { path: `workspace/${id}`, present: true, commit: SHA },
  sameCommit: true,
  catalog: { from: "facts", fromFacts: 9, fromReaders: 0 },
  state,
});
const PROXY = repo("northwind_pay_1-0", "trusted");
const LEDGER = repo("forge-ledger", "trusted");
const UNREAD: Api.TrustRepoT = {
  ...repo("forge-gateway", "not-read"),
  facts: { path: "facts/forge-gateway.jsonl", present: false, count: 0, unverified: 0 },
  verify: { path: "facts/forge-gateway.verify.yaml", report: null },
};
const page = (filter: string) =>
  renderToStaticMarkup(
    <TrustPage
      filter={filter}
      of={{
        state: "ready",
        data: { factsDir: "facts", repos: [LEDGER, PROXY, UNREAD], problems: [] },
      }}
    />,
  );
const ctx = (allowed: boolean): Ctx => ({
  run: null,
  allowed,
  ask: () => undefined,
  stop: async () => undefined,
  stopping: false,
  consoleOpen: false,
  setConsoleOpen: () => undefined,
  loadEarlier: () => undefined,
});
const withCopilot = (node: ReactNode) =>
  renderToStaticMarkup(<RunsContext.Provider value={ctx(true)}>{node}</RunsContext.Provider>);

describe("Map › Trust: a filter over the repos (beta.27)", () => {
  it("has a labelled filter box over the repos' sections", () => {
    const out = page("");
    expect(out).toContain('<label for="trust-filter"');
    expect(out).toContain(esc(T.filterLabel));
    expect(out).toContain('id="trust-filter"');
    expect(out).toContain(`placeholder="${esc(F.placeholder)}"`);
    // Every repo's section, the count's live region empty while nothing is filtered.
    for (const r of [LEDGER, PROXY, UNREAD]) expect(out).toContain(`id="trust-${r.repo}"`);
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain(esc(F.shown(3, 3)));
  });

  it("shows only the repos whose id has every word, and says how many", () => {
    const out = page("northwind PAY");
    expect(out).toContain('id="trust-northwind_pay_1-0"');
    expect(out).not.toContain('id="trust-forge-ledger"');
    expect(out).not.toContain('id="trust-forge-gateway"');
    expect(out).toContain(esc(F.shown(1, 3)));
    // The page's own counts stay the estate's.
    expect(out).toContain(esc(T.summary(2, 3)));
  });

  it("says when nothing matches, with the button that clears it", () => {
    const out = page("forge-teller");
    expect(out).toContain(esc(F.nothingMatches(`“forge-teller”`)));
    expect(out).toContain(esc(F.clear));
    expect(out).not.toContain('id="trust-forge-ledger"');
  });

  it("matches by the repo's id, case aside", () => {
    expect(trustRepoMatches(PROXY, "NORTHWIND")).toBe(true);
    expect(trustRepoMatches(PROXY, "northwind ledger")).toBe(false);
    expect(trustRepoMatches(LEDGER, "")).toBe(true);
  });

  it("draws no box when there is no repo (the empty state says what to do)", () => {
    const out = renderToStaticMarkup(
      <TrustRepos repos={[]} filter="" onFilter={() => undefined} />,
    );
    expect(out).not.toContain("trust-filter");
  });
});

describe("Map › Trust: Read it again on every read repo (beta.27)", () => {
  it("offers a fresh, fully covered repo a whole read again, in its own labelled section", () => {
    const out = withCopilot(<TrustRow r={PROXY} />);
    expect(out).toContain('aria-labelledby="trust-northwind_pay_1-0-again"');
    expect(out).toContain('id="trust-northwind_pay_1-0-again"');
    expect(out).toContain(esc(T.readAgain.title));
    expect(out).toContain(esc(T.readAgain.why("northwind_pay_1-0")));
    // The same Read as everywhere (ReadRepo): with Copilot, the whole repo again (`force`).
    expect(out).toContain(esc(COPY.copilotRuns.start.again("northwind_pay_1-0")));
    // Once: the section's button, not a second one in the header.
    expect(out.split(esc(COPY.copilotRuns.start.again("northwind_pay_1-0"))).length - 1).toBe(1);
  });

  it("offers it on a stale or rejected repo too, and never on a repo not read yet", () => {
    for (const s of ["stale", "rejected", "unknown-files", "unwritten"] as const)
      expect(withCopilot(<TrustRow r={{ ...PROXY, state: s }} />), s).toContain(
        esc(T.readAgain.title),
      );
    const unread = withCopilot(<TrustRow r={UNREAD} />);
    expect(unread).not.toContain(esc(T.readAgain.title));
    expect(unread).not.toContain(esc(COPY.copilotRuns.start.again("forge-gateway")));
  });
});
