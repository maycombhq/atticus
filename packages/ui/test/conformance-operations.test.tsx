import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";

/**
 * ADR 0203 (the review of part B): operations are not checked against the code in this release,
 * and the app says so as the command line does: a change whose work is operations only is not
 * offered the architecture stage, and a change of flows and operations is never shown as all
 * good without the line that says how many operations aren't checked. With the panel's loading,
 * error and empty states. No network: the client's reads are given.
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

describe("the conformance panel and a change's operations (ADR 0203)", () => {
  it("says a change whose work is operations only isn't checked, and offers no architecture stage", () => {
    const out = renderToStaticMarkup(<ConformanceView c={VIEW} />);
    expect(out).toContain(esc(C.onlyOperations(2)));
    expect(C.onlyOperations(2)).toBe(
      "This change's work is operations (2): Atticus doesn't check operations against the code in this release.",
    );
    expect(out).not.toContain(esc(C.noTargets(CHANGE)));
    expect(out).not.toContain("atticus change architecture");
  });

  it("never shows a change of flows and operations as all good without the operations it doesn't check", () => {
    const mixed = { ...VIEW, flows: 1, results: [RESULT], round: 1 };
    const out = renderToStaticMarkup(<ConformanceView c={mixed} />);
    expect(out).toContain(esc(C.allGood));
    expect(out).toContain(esc(C.operationsNotChecked(2)));
    expect(C.operationsNotChecked(2)).toBe(
      "2 operations are not checked: Atticus doesn't check operations against the code in this release.",
    );
    expect(C.operationsNotChecked(1)).toBe(
      "1 operation is not checked: Atticus doesn't check operations against the code in this release.",
    );
    // Before its first check too.
    const before = renderToStaticMarkup(<ConformanceView c={{ ...mixed, results: [] }} />);
    expect(before).toContain(esc(C.operationsNotChecked(2)));
    // A change with no operations, or from a server that doesn't say, reads as before.
    const flows = renderToStaticMarkup(<ConformanceView c={{ ...mixed, operations: 0 }} />);
    const older = { ...mixed } as Partial<Api.ChangeConformanceT>;
    delete older.operations;
    for (const x of [
      flows,
      renderToStaticMarkup(<ConformanceView c={older as Api.ChangeConformanceT} />),
    ])
      expect(x).not.toContain("not checked: Atticus");
  });

  it("is loading, then says what failed, and with no change says how to start one", () => {
    reads.set("/api/changes", { state: "ready", data: [{ id: CHANGE, title: VIEW.title }] });
    const hash = `#/conformance?change=${CHANGE}`;
    expect(renderToStaticMarkup(<Conformance hash={hash} />)).toContain('aria-busy="true"');
    reads.set(PATH, { state: "error", error: "The server answered 500." });
    const failed = renderToStaticMarkup(<Conformance hash={hash} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(COPY.app.cantLoad("The server answered 500.")));
    reads.set(PATH, { state: "ready", data: VIEW });
    expect(renderToStaticMarkup(<Conformance hash={hash} />)).toContain(esc(C.onlyOperations(2)));
    reads.set("/api/changes", { state: "ready", data: [] });
    expect(renderToStaticMarkup(<Conformance hash="#/conformance" />)).toContain(esc(C.none));
  });
});
