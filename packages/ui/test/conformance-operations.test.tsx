import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";

/**
 * ADR 0206: a change's operations, and a quick change's In the code, are checked against the
 * code as claims, and the app shows each with its outcome, where it is stated, its cite and what
 * the person does next, as the command line does. Nothing says operations aren't checked. With
 * the panel's loading, error and empty states. No network: the client's reads are given.
 */

const C = COPY.conformance;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

type Loaded =
  { state: "loading" } | { state: "error"; error: string } | { state: "ready"; data: unknown };
const reads = new Map<string, Loaded>();
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    useApi: (path: string | undefined) => ({
      ...(path ? (reads.get(path) ?? { state: "loading" }) : { state: "loading" }),
      reload: () => undefined,
      refreshing: false,
    }),
    useLiveEvents: () => undefined,
  };
});
const { Conformance, ConformanceView } = await import("../src/screens/work/Conformance.js");

const CHANGE = "move-ledger-platform";
const PATH = `/api/changes/${CHANGE}/conformance`;
const RESULT: Api.ConformRepoResultT = {
  schemaVersion: 1,
  change: CHANGE,
  repo: "forge-ledger",
  ref: `change/${CHANGE}`,
  commit: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
  base: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
  checkedAt: "2026-11-19T09:00:00Z",
  counts: { found: 1, missing: 0, stillThere: 0, unexpected: 0 },
  items: [
    {
      status: "found",
      check: "publish",
      flow: "forge-ledger.settle-refund",
      item: 3,
      what: "forge-ledger publishes to forge.refunds.settled.",
      at: [{ source: "code", repo: "forge-ledger", path: "src/RefundEvents.java", line: 9 }],
    },
  ],
  unchecked: [],
  problems: [],
};
const VIEW: Api.ChangeConformanceT = {
  change: CHANGE,
  title: "Move the ledger to Forge Cloud",
  flows: 0,
  operations: 2,
  results: [],
  gate: "conform",
  problems: [],
};

beforeEach(() => reads.clear());

const CLAIMED: Api.ConformRepoResultT = {
  ...RESULT,
  counts: {
    found: 0,
    missing: 0,
    stillThere: 0,
    unexpected: 0,
    claims: { present: 1, differs: 0, missing: 0, notCheckable: 1, unconfirmed: 0 },
  },
  items: [],
  claims: [
    {
      outcome: "present",
      check: "deployment",
      repo: "forge-ledger",
      from: { file: "target-flows/_operations.yaml", line: 4, operation: "deploy-new" },
      expected: "platform forge-cloud",
      what: "forge-ledger runs on forge-cloud.",
      at: [{ source: "code", repo: "forge-ledger", path: "deploy/cloud.yaml", line: 3 }],
      why: "Written on the cited lines: platform forge-cloud.",
      next: "Nothing: the line is cited for the reviewer.",
    },
    {
      outcome: "not-checkable",
      check: "cut-over",
      repo: "forge-ledger",
      from: { file: "target-flows/_operations.yaml", line: 9, operation: "switch" },
      expected: "undo: Point the route back.",
      what: "switch is a cut-over in forge-ledger: an act in a live system, which Atticus never connects to.",
      at: [{ source: "artifact", path: "target-flows/_operations.yaml", line: 9 }],
      next: 'Check it by hand, then say how: atticus finding move-ledger-platform conform-not-checked-cut-over-switch-forge-ledger waive --reason "<how it was checked>".',
      finding: { id: "conform-not-checked-cut-over-switch-forge-ledger", state: "open" },
    },
  ],
};

describe("the conformance panel and the claims a change states (ADR 0206)", () => {
  it("shows each claim with its outcome, where it is stated, its cite and what to do next", () => {
    const out = renderToStaticMarkup(
      <ConformanceView c={{ ...VIEW, claims: 2, results: [CLAIMED], round: 1 }} />,
    );
    expect(out).toContain(esc(C.claimsTitle));
    expect(out).toContain(esc(C.claimCounts(CLAIMED.counts.claims!)));
    expect(out).toContain(esc(C.outcome["not-checkable"]!));
    expect(out).toContain("target-flows/_operations.yaml:9");
    expect(out).toContain("forge-ledger:deploy/cloud.yaml:3");
    expect(out).toContain(esc(CLAIMED.claims![1]!.next));
    expect(out).toContain("conform-not-checked-cut-over-switch-forge-ledger (open)");
    // Something to check by hand is never shown as all good.
    expect(out).not.toContain(esc(C.allGood));
    expect(out).not.toContain("check operations against");
    expect(out).toContain('<caption class="sr">');
  });

  it("a change with no flow and no claim says what writes them; one with claims is offered the check", () => {
    const none = renderToStaticMarkup(<ConformanceView c={VIEW} />);
    expect(none).toContain(esc(C.nothingYet(CHANGE)));
    const before = renderToStaticMarkup(<ConformanceView c={{ ...VIEW, claims: 2 }} />);
    expect(before).toContain(esc(C.notChecked(CHANGE)));
    expect(before).toContain(`atticus change conform ${CHANGE}`);
  });

  it("is loading, then says what failed, and with no change says how to start one", () => {
    reads.set("/api/changes", { state: "ready", data: [{ id: CHANGE, title: VIEW.title }] });
    const hash = `#/conformance?change=${CHANGE}`;
    expect(renderToStaticMarkup(<Conformance hash={hash} />)).toContain('aria-busy="true"');
    reads.set(PATH, { state: "error", error: "The server answered 500." });
    const failed = renderToStaticMarkup(<Conformance hash={hash} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(COPY.app.cantLoad("The server answered 500.")));
    reads.set(PATH, { state: "ready", data: { ...VIEW, claims: 2, results: [CLAIMED] } });
    expect(renderToStaticMarkup(<Conformance hash={hash} />)).toContain(esc(C.claimsTitle));
    reads.set("/api/changes", { state: "ready", data: [] });
    expect(renderToStaticMarkup(<Conformance hash="#/conformance" />)).toContain(esc(C.none));
  });
});

describe("the review of ADR 0206: a quick change, a change of claims only, and the claims' words", () => {
  it("a quick change with nothing to check yet is offered the quick path's next step, never a stage", () => {
    const out = renderToStaticMarkup(<ConformanceView c={{ ...VIEW, operations: 0 }} quick />);
    expect(out).toContain(esc(C.nothingYetQuick(CHANGE)));
    expect(out).toContain(`atticus change status ${CHANGE}`);
    expect(out).not.toContain("atticus change architecture");
    // The screen reads it from the change's row, as Home does.
    reads.set("/api/changes", {
      state: "ready",
      data: [{ id: CHANGE, title: VIEW.title, quickPath: true }],
    });
    reads.set(PATH, { state: "ready", data: { ...VIEW, operations: 0 } });
    const screen = renderToStaticMarkup(<Conformance hash={`#/conformance?change=${CHANGE}`} />);
    expect(screen).toContain(esc(C.nothingYetQuick(CHANGE)));
    expect(screen).not.toContain("atticus change architecture");
  });

  it("a change of claims only leads with its claims' counts, never the flows' zeros", () => {
    const out = renderToStaticMarkup(
      <ConformanceView c={{ ...VIEW, claims: 2, results: [CLAIMED], round: 1 }} />,
    );
    const big = /<p class="est-big">([^<]*)<\/p>/.exec(out)?.[1];
    expect(big).toBe(esc(C.claimCounts(CLAIMED.counts.claims!)));
    expect(out).not.toContain(esc(C.counts(CLAIMED.counts)));
    // And no empty table of flow items.
    expect(out).not.toContain(esc(C.itemsCaption("forge-ledger")));
  });

  it("the claims' framing words come from the copy file", () => {
    const out = renderToStaticMarkup(
      <ConformanceView c={{ ...VIEW, claims: 2, results: [CLAIMED], round: 1 }} />,
    );
    expect(out).toContain(esc(C.claimWhy(CLAIMED.claims![0]!.why!)));
    expect(out).toContain(esc(C.claimNextNone));
  });
});
