import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { ConformanceView } from "../src/screens/work/Conformance.js";

/** Code against design (ADR 0114): each item found, missing or not in the design, with its line. */

const C = COPY.conformance;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const RESULT: Api.ConformRepoResultT = {
  schemaVersion: 1,
  change: "add-transfer-limit",
  repo: "forge-ledger",
  ref: "task/add-transfer-limit/1.3",
  commit: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
  base: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
  task: "1.3",
  checkedAt: "2026-10-23T09:00:00Z",
  counts: { found: 1, missing: 1, stillThere: 0, unexpected: 1 },
  items: [
    {
      status: "found",
      check: "column",
      flow: "ledger-api.create-transfer",
      item: 1,
      task: "1.1",
      what: "ledger-db.account has the column daily_limit.",
      record: "ledger-db.account.daily-limit",
      at: [
        {
          source: "code",
          repo: "forge-ledger",
          path: "src/main/resources/db/migration/V3__add_daily_limit.sql",
          line: 1,
        },
      ],
    },
    {
      status: "missing",
      check: "call",
      flow: "ledger-api.create-transfer",
      item: 2,
      task: "1.3",
      what: "ledger-api makes no call to northwind-pay POST /v2/velocity-checks (item 2 of target-flows/ledger-api.create-transfer.yaml).",
      at: [{ source: "artifact", path: "target-flows/ledger-api.create-transfer.yaml", line: 18 }],
      finding: { id: "conform-missing-call-ledger-api-create-transfer-2", state: "open" },
    },
    {
      status: "unexpected",
      check: "call",
      what: "ledger-api calls northwind-pay POST /v2/refunds, which no target flow names.",
      record: "if-e25b9623de50b834",
      at: [
        {
          source: "code",
          repo: "forge-ledger",
          path: "src/main/java/forge/ledger/NorthwindClient.java",
          line: 11,
        },
      ],
      finding: { id: "conform-unexpected-call-if-e25b9623de50b834", state: "dismissed" },
    },
  ],
  unchecked: [
    {
      flow: "ledger-api.create-transfer",
      item: 3,
      kind: "branch",
      why: "A step of this kind names no call, table, column or migration a scan records; a person or a test checks it.",
    },
  ],
  problems: [],
};

const VIEW: Api.ChangeConformanceT = {
  change: "add-transfer-limit",
  title: "Add a daily transfer limit",
  flows: 2,
  results: [RESULT],
  gate: "conform",
  round: 2,
  problems: [],
};

describe("Code against design (ADR 0114)", () => {
  it("is a tab of a change, in Build (ADR 0119)", () => {
    expect(screenOf("#/conformance?change=add-transfer-limit")).toMatchObject({
      id: "conformance",
      group: "Build",
    });
  });

  it("shows each item's result in words, its step and task, where it is, and its finding's state", () => {
    const out = renderToStaticMarkup(<ConformanceView c={VIEW} />);
    expect(out).toContain(esc(C.repo("forge-ledger", "task/add-transfer-limit/1.3")));
    expect(out).toContain(esc(C.counts(RESULT.counts)));
    expect(out).toContain(`<strong>${esc(C.status.missing!)}</strong>`);
    expect(out).toContain(`<strong>${esc(C.status.unexpected!)}</strong>`);
    expect(out).toContain("target-flows/ledger-api.create-transfer.yaml:18");
    expect(out).toContain("forge-ledger:src/main/java/forge/ledger/NorthwindClient.java:11");
    expect(out).toContain(esc(C.step("ledger-api.create-transfer", 2)));
    expect(out).toContain("conform-unexpected-call-if-e25b9623de50b834 (dismissed)");
    expect(out).toContain(esc(C.unchecked));
    expect(out).toContain(esc(C.gate(2)));
    expect(out).toContain("<caption");
  });

  it("says when everything is there", () => {
    const out = renderToStaticMarkup(
      <ConformanceView
        c={{
          ...VIEW,
          results: [
            {
              ...RESULT,
              counts: { found: 1, missing: 0, stillThere: 0, unexpected: 0 },
              items: [RESULT.items[0]!],
            },
          ],
        }}
      />,
    );
    expect(out).toContain(esc(C.allGood));
  });

  it("before a check, and before the architecture stage, gives the command to run", () => {
    const none = renderToStaticMarkup(<ConformanceView c={{ ...VIEW, results: [] }} />);
    expect(none).toContain(esc(C.notChecked("add-transfer-limit")));
    expect(none).toContain("atticus change conform add-transfer-limit");
    const early = renderToStaticMarkup(<ConformanceView c={{ ...VIEW, flows: 0, results: [] }} />);
    expect(early).toContain(esc(C.noTargets("add-transfer-limit")));
    expect(early).toContain("atticus change architecture add-transfer-limit");
  });
});
